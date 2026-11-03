// dsh-geo-toolkit / lib/psd.js
// 读 PSD 版式：图层树 → 文字层级 / 区域 / 色板 → 版式 JSON 草稿。
//
// 实测要点（ag-psd 34）：
//  - 层的位置在 layer.top/left/bottom/right，不在 bounds；
//  - 文字字号在 text.style.fontSize（pt），实际视觉高度 ≈ layer 高度；
//  - text.transform 带缩放（常见 2 倍）；
//  - fillColor 的数值范围不统一（有的 0–1、有的 0–255、有的溢出），只能作参考色。
// 读取用 skipLayerImageData，几十 MB 的 PSD 几十毫秒。

import fs from 'node:fs';
import { readPsd } from 'ag-psd';

/**
 * 读 PSD 版式结构（不含像素）。
 * @param {string} file
 */
export function readPsdLayout(file) {
  const psd = readPsd(fs.readFileSync(file), {
    skipLayerImageData: true,
    skipCompositeImageData: true,
    skipThumbnail: true,
  });
  const res = psd.imageResources && psd.imageResources.resolutionInfo;
  const dpi = Number(res && res.horizontalResolution) || 300;
  const layers = [];
  walk(psd.children, 0, layers);
  return { width: psd.width, height: psd.height, dpi, layers };
}

function walk(nodes, depth, out) {
  for (const n of nodes || []) {
    if (typeof n.left !== 'number') continue; // 无几何信息的层跳过
    const layer = {
      name: n.name || '',
      depth,
      kind: n.text ? 'text' : (n.children ? 'group' : 'pixel'),
      visible: n.hidden !== true,
      left: n.left,
      top: n.top,
      right: n.right,
      bottom: n.bottom,
      width: n.right - n.left,
      height: n.bottom - n.top,
    };
    if (n.text) {
      const st = n.text.style || {};
      const t = n.text.transform || [];
      const scale = Number(t[0]) || 1;
      layer.text = String(n.text.text || '');
      layer.fontSize = Number(st.fontSize) || null;
      layer.font = st.font && st.font.name ? st.font.name : null;
      layer.bold = Boolean(st.fauxBold);
      layer.color = colorToHex(st.fillColor);
      layer.align = (n.text.paragraphStyle && n.text.paragraphStyle.justification) || null;
      // 字号缺失时用层高推算；多行文字要按行数折算，否则一整段正文会被当成大标题
      const lineCount = String(n.text.text || '').split('\n').length;
      layer.effectiveSize = layer.fontSize ? layer.fontSize * scale : layer.height / Math.max(1, lineCount);
      layer.lineCount = lineCount;
    }
    out.push(layer);
    if (n.children) walk(n.children, depth + 1, out);
  }
}

/** fillColor 归一化成 #rrggbb（数值范围不统一，做兜底）。 */
export function colorToHex(c) {
  if (!c || typeof c.r !== 'number') return null;
  const v = [c.r, c.g, c.b];
  const max = Math.max(...v);
  let rgb;
  if (max > 1 && max <= 255) rgb = v.map((x) => Math.max(0, Math.min(255, Math.round(x))));
  else if (max > 255) rgb = v.map((x) => Math.max(0, Math.min(255, Math.round(x / max * 255))));
  else rgb = v.map((x) => Math.round(x * 255));
  return '#' + rgb.map((x) => x.toString(16).padStart(2, '0')).join('');
}

/** 文字层级聚类：按视觉字号分档（相差 20% 以内归一档）。 */
export function textLevels(layout) {
  const texts = layout.layers.filter((l) => l.kind === 'text' && l.visible && l.text && l.text.trim());
  const sorted = [...texts].sort((a, b) => (b.effectiveSize || 0) - (a.effectiveSize || 0));
  const levels = [];
  for (const t of sorted) {
    const size = t.effectiveSize || 0;
    const hit = levels.find((lv) => Math.abs(lv.size - size) / Math.max(lv.size, size) < 0.2);
    if (hit) {
      hit.items.push(t);
      hit.size = (hit.size * (hit.items.length - 1) + size) / hit.items.length;
    } else {
      levels.push({ size, items: [t] });
    }
  }
  return levels.map((lv) => ({
    size: Math.round(lv.size),
    count: lv.items.length,
    samples: lv.items.slice(0, 6).map((t) => ({
      text: t.text.replace(/\s+/g, ' ').slice(0, 32),
      x: t.left,
      y: t.top,
      color: t.color,
      font: t.font,
    })),
  }));
}

/** 按纵向分布粗分区域（顶部 / 上部 / 中部 / 下部 / 底部）。 */
export function regions(layout) {
  const h = layout.height;
  const bands = [
    { name: '顶部', from: 0, to: 0.08 },
    { name: '上部', from: 0.08, to: 0.3 },
    { name: '中部', from: 0.3, to: 0.75 },
    { name: '下部', from: 0.75, to: 0.94 },
    { name: '底部', from: 0.94, to: 1 },
  ];
  return bands.map((b) => {
    const texts = layout.layers.filter((l) => l.kind === 'text' && l.visible && l.top / h >= b.from && l.top / h < b.to);
    const groups = [...new Set(layout.layers.filter((l) => l.kind === 'group' && l.top / h >= b.from && l.top / h < b.to).map((l) => l.name))];
    return { name: b.name, texts: texts.length, groups: groups.slice(0, 8), samples: texts.slice(0, 4).map((t) => t.text.replace(/\s+/g, ' ').slice(0, 24)) };
  });
}

/** 从 PSD 生成一份适配当前渲染器的版式 JSON 草稿。 */
export function layoutToStyle(layout, opts = {}) {
  const levels = textLevels(layout);
  const w = layout.width;
  const h = layout.height;
  const mmW = w / layout.dpi * 25.4;
  const mmH = h / layout.dpi * 25.4;
  const canvasW = 1800;
  const canvasH = Math.round(canvasW * h / w);
  const k = canvasW / w;

  // 标题优先取「上半部分、单行、字号最大」的那条；取不到再退回全图最大
  const topCandidates = layout.layers.filter((l) => l.kind === 'text' && l.visible && l.text.trim()
    && l.top < h * 0.16 && (l.lineCount || 1) === 1 && l.effectiveSize);
  topCandidates.sort((a, b) => b.effectiveSize - a.effectiveSize);
  const titleLayer = topCandidates[0] || null;
  const level1 = levels[0];
  const titleSample = titleLayer
    ? { text: titleLayer.text, x: titleLayer.left, y: titleLayer.top, font: titleLayer.font, color: titleLayer.color }
    : (level1 && level1.samples[0] ? level1.samples[0] : null);
  const titleSizeRaw = titleLayer ? titleLayer.effectiveSize : (level1 ? level1.size : null);
  const subLevel = levels.find((lv, i) => i > 0 && lv.count <= 8) || levels[1] || null;
  const titleSize = titleSizeRaw ? Math.round(titleSizeRaw * k) : Math.round(canvasH * 0.04);

  const topTexts = layout.layers.filter((l) => l.kind === 'text' && l.visible && l.top < h * 0.08);
  const bottomTexts = layout.layers.filter((l) => l.kind === 'text' && l.visible && l.top > h * 0.92);
  const bandBottom = Math.max(h * 0.06, ...topTexts.map((t) => t.bottom)) ;
  const mapTop = Math.round(Math.min(h * 0.2, bandBottom * 1.1) * k);
  const mapBottom = Math.round(Math.min(h * 0.9, Math.min(...(bottomTexts.length ? bottomTexts.map((t) => t.top) : [h * 0.95]))) * k);

  const style = {
    name: opts.name || 'from-psd',
    description: '从 ' + (opts.source || 'PSD') + ' 提取的版式草稿（单主图适配；多图区需要手工拆分）',
    canvas: { width: canvasW, height: canvasH },
    page: {
      size: 'custom',
      mmW: Math.round(mmW),
      mmH: Math.round(mmH),
      dpi: layout.dpi,
      background: '#ffffff',
      fitContent: true,
      bottomMargin: Math.round(canvasH * 0.02),
    },
    frame: null,
    title: {
      band: { x: 0, y: 0, w: 'full', h: mapTop, bottomRule: null },
      left: titleSample
        ? {
            x: Math.round(titleSample.x * k),
            y: 0,
            text: '',
            font: titleSample.font || 'SimHei',
            size: titleSize,
            bold: true,
            color: titleSample.color || '#111111',
            valign: 'middle',
          }
        : null,
      right: subLevel && subLevel.samples[0]
        ? {
            x: 'right',
            y: 0,
            text: '',
            font: subLevel.samples[0].font || 'SimHei',
            size: Math.round(subLevel.size * k),
            color: subLevel.samples[0].color || '#111111',
            valign: 'middle',
          }
        : null,
    },
    map: { x: 0, y: mapTop, w: 'full', h: 'auto', border: null },
    sidebar: null,
    layerStyles: [
      { match: '道路|街巷|红线|路', stroke: '#e0447c', width: 5, fill: 'none' },
      { match: '地块|用地|住宅|商业|公园|绿地', stroke: '#9a9a9a', width: 1.4, fillAuto: true, fillOpacity: 0.75 },
      { match: '建筑', stroke: '#333333', width: 1.2, fill: '#d9d3c8', fillOpacity: 0.85 },
      { match: '.*', stroke: '#555555', width: 1.1, fill: 'none' },
    ],
    palette: ['#d94f4f', '#f2c14e', '#7fb069', '#4a90d9', '#b07aa1', '#e08a5c', '#5ab0b0', '#c9c94a', '#8c8c8c', '#c98bb9'],
    legendAuto: { enabled: false, maxItems: 8 },
    _psd: {
      levels: levels.map((lv) => ({ size: lv.size, count: lv.count, sample: lv.samples[0] ? lv.samples[0].text : '' })),
      note: 'levels 是全量文字层级；当前 style 只取了最大字号做标题、次档做右上图名。',
    },
  };
  return style;
}

/** 人读报告。 */
export function formatPsdReport(layout, levels, regionList) {
  const lines = [];
  lines.push('画布：' + layout.width + ' × ' + layout.height + ' px @' + layout.dpi + 'dpi = '
    + (layout.width / layout.dpi * 25.4).toFixed(0) + ' × ' + (layout.height / layout.dpi * 25.4).toFixed(0) + ' mm');
  lines.push('图层：' + layout.layers.length + ' 个（文字 ' + layout.layers.filter((l) => l.kind === 'text').length
    + ' / 组 ' + layout.layers.filter((l) => l.kind === 'group').length
    + ' / 像素 ' + layout.layers.filter((l) => l.kind === 'pixel').length + '）');
  lines.push('文字层级：');
  for (const lv of levels.slice(0, 6)) {
    const s = lv.samples[0] || {};
    lines.push('  ' + lv.size + 'px × ' + lv.count + ' 条  例：' + JSON.stringify(s.text || '') + (s.font ? ' 字体 ' + s.font : '') + (s.color ? ' 色 ' + s.color : ''));
  }
  lines.push('纵向区域：');
  for (const r of regionList) {
    if (!r.texts && !r.groups.length) continue;
    lines.push('  ' + r.name + '：文字 ' + r.texts + ' 条' + (r.groups.length ? '，组 ' + r.groups.join('、') : ''));
  }
  return lines.join('\n');
}
