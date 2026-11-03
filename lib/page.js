// dsh-geo-toolkit / lib/page.js
// 版式页面：图框 + 标题条 + 主图 + 侧栏（指北针 / 比例尺 / 图例 / 说明）。
// 全部坐标按 style.canvas 的参考画布画，SVG 的 width/height 才换成目标像素——缩放只发生一次。

import { renderMapGroup, escapeXml } from './svg.js';
import { pagePixels, compileLayerStyles } from './style.js';
import { layerStats, cleanDxfText } from './geo.js';

/** 尺寸：数字原样；"full" 撑满；"rest" 撑到剩余；"right"/"center" 由调用方换算。 */
function dim(v, total, start = 0) {
  if (typeof v === 'number') return v;
  if (v === 'full') return total;
  if (v === 'rest') return total - start;
  return Number(v) || 0;
}

/** 横向锚点：数字 = 左端；"right" = 右对齐（需要元素宽）。 */
function anchorX(v, canvasW, width = 0) {
  if (v === 'right') return canvasW - width;
  if (v === 'center') return (canvasW - width) / 2;
  return Number(v) || 0;
}

/** 文本换行：按字宽粗估（中文按 1 字宽，英文按 0.55）。 */
function wrapText(text, maxChars) {
  const lines = [];
  for (const para of String(text || '').split('\n')) {
    let cur = '';
    let w = 0;
    for (const ch of para) {
      const cw = /[\x00-\x7f]/.test(ch) ? 0.55 : 1;
      if (w + cw > maxChars) {
        // 标点不放到行首：往回带一个字
        if ('，。、；：？！）」』,.!?:;)'.includes(ch) && cur.length > 1) {
          const last = cur.slice(-1);
          lines.push(cur.slice(0, -1));
          cur = last;
          w = 1;
        } else {
          lines.push(cur);
          cur = '';
          w = 0;
        }
      }
      cur += ch;
      w += cw;
    }
    lines.push(cur);
  }
  return lines;
}

/** 指北针：八瓣罗盘，黑白相间。 */
function northArrow(cx, cy, size) {
  const r = size / 2;
  const parts = ['<g transform="translate(' + cx.toFixed(1) + ',' + cy.toFixed(1) + ')">'];
  for (let i = 0; i < 8; i++) {
    const a0 = (i * 45 - 90) * Math.PI / 180;
    const a1 = ((i + 1) * 45 - 90) * Math.PI / 180;
    const p1 = [r * Math.cos(a0), r * Math.sin(a0)];
    const p2 = [r * Math.cos(a1), r * Math.sin(a1)];
    const fill = i % 2 === 0 ? '#111111' : '#ffffff';
    parts.push('<path d="M0,0 L' + p1[0].toFixed(1) + ',' + p1[1].toFixed(1) + ' L' + p2[0].toFixed(1) + ',' + p2[1].toFixed(1) + ' Z" fill="' + fill + '" stroke="#111111" stroke-width="0.8"/>');
  }
  parts.push('<circle r="' + r.toFixed(1) + '" fill="none" stroke="#111111" stroke-width="1.2"/>');
  parts.push('</g>');
  return parts.join('');
}

/** 比例尺：按数值比例分段，黑白交替。 */
function scaleBar(cfg, cx) {
  const segs = cfg.segments && cfg.segments.length >= 2 ? cfg.segments : [0, 100, 200];
  const min = segs[0];
  const max = segs[segs.length - 1];
  const totalW = cfg.width || 300;
  const h = cfg.height || 9;
  const y = cfg.y;
  const x0 = cx - totalW / 2;
  const parts = [];
  for (let i = 0; i < segs.length - 1; i++) {
    const w = (segs[i + 1] - segs[i]) / (max - min) * totalW;
    const x = x0 + (segs[i] - min) / (max - min) * totalW;
    parts.push('<rect x="' + x.toFixed(1) + '" y="' + y + '" width="' + w.toFixed(1) + '" height="' + h + '" fill="' + (i % 2 === 0 ? '#111111' : '#ffffff') + '" stroke="#111111" stroke-width="0.8"/>');
  }
  for (const v of segs) {
    const x = x0 + (v - min) / (max - min) * totalW;
    parts.push('<text x="' + x.toFixed(1) + '" y="' + (y + h + 18) + '" font-size="11" text-anchor="middle" fill="#111" font-family="Microsoft YaHei,sans-serif">' + v + '</text>');
  }
  parts.push('<text x="' + (x0 + totalW + 26).toFixed(1) + '" y="' + (y + h + 18) + '" font-size="11" fill="#111" font-family="Microsoft YaHei,sans-serif">' + escapeXml(cfg.unit || '米') + '</text>');
  return parts.join('');
}

/** 图例：标题 + 项（色块 + 文字）。 */
function legendBlock(cfg, items) {
  const parts = [];
  const title = cfg.title || { text: '图例', size: 26, y: 318 };
  parts.push('<text x="' + (cfg.cx || 0) + '" y="' + title.y + '" font-size="' + (title.size || 26) + '" text-anchor="middle" fill="#111" font-family="' + (title.font || 'SimHei') + ',sans-serif">' + escapeXml(title.text || '图例') + '</text>');
  let y = cfg.startY || 372;
  const sw = (cfg.swatch && cfg.swatch.w) || 46;
  const sh = (cfg.swatch && cfg.swatch.h) || 22;
  const labelX = cfg.label && cfg.label.x || 66;
  const labelSize = (cfg.label && cfg.label.size) || 19;
  for (const it of items) {
    const x = (cfg.cx || 0) - 120;
    if (it.kind === 'line') {
      parts.push('<line x1="' + x + '" y1="' + (y + sh / 2) + '" x2="' + (x + sw) + '" y2="' + (y + sh / 2) + '" stroke="' + it.color + '" stroke-width="' + (it.width || 4) + '"/>');
    } else if (it.kind === 'dash') {
      parts.push('<line x1="' + x + '" y1="' + (y + sh / 2) + '" x2="' + (x + sw) + '" y2="' + (y + sh / 2) + '" stroke="' + it.color + '" stroke-width="' + (it.width || 3) + '" stroke-dasharray="8 5"/>');
    } else {
      parts.push('<rect x="' + x + '" y="' + y + '" width="' + sw + '" height="' + sh + '" fill="' + it.color + '" stroke="#333" stroke-width="0.6"/>');
    }
    parts.push('<text x="' + (x + labelX) + '" y="' + (y + sh - 5) + '" font-size="' + labelSize + '" fill="#111" font-family="Microsoft YaHei,sans-serif">' + escapeXml(it.label) + '</text>');
    y += (cfg.rowHeight || 34);
  }
  return { svg: parts.join(''), endY: y };
}

/**
 * 渲染整页。
 * @param {Array} entities 地图实体
 * @param {object} opts { style, title, subtitle, note, legendItems, maxTexts, focus }
 */
export function renderPage(entities, opts = {}) {
  const style = opts.style;
  const canvas = style.canvas;
  const pxBase = pagePixels(style);
  const allLayers = [...new Set(entities.map((e) => e.layer || '0'))];
  const layerStyle = compileLayerStyles(style, allLayers);

  const w = canvas.width;
  let h = canvas.height;
  const parts = [];
  const textLayers = [];
  const asLayer = Boolean(opts.textAsLayers);

  // 页面高度随内容收紧（PSD 草稿默认开）：先量主图，再定页高
  const mCfg = style.map || {};
  if (style.page.fitContent && !opts._probed) {
    const probeW = dim(mCfg.w ?? (w - 36), w);
    const probeY = dim(mCfg.y ?? 114, h);
    const probe = renderMapGroup(entities, {
      width: probeW,
      layerStyles: compileLayerStyles(style, entities.map((e) => e.layer || '0')),
      maxTexts: opts.maxTexts ?? 400,
      focus: opts.focus !== false,
      background: style.page.background,
    });
    h = Math.ceil(probeY + (probe ? probe.height : 400) + (style.page.bottomMargin ?? 60));
  }

  // 像素尺寸按最终页高重算（fitContent 时页高变了，mm 也要跟着变）
  const mmPerPx = pxBase.mmW / w;
  const px = {
    width: pxBase.width,
    height: Math.round(h * mmPerPx / 25.4 * pxBase.dpi),
    dpi: pxBase.dpi,
    mmW: pxBase.mmW,
    mmH: Math.round(h * mmPerPx),
  };

  // 页面背景
  if (style.page.background) parts.push('<rect width="' + w + '" height="' + h + '" fill="' + style.page.background + '"/>');

  // 外框
  if (style.frame) {
    const f = style.frame;
    parts.push('<rect x="' + f.inset + '" y="' + f.inset + '" width="' + (w - f.inset * 2) + '" height="' + (h - f.inset * 2) + '" fill="none" stroke="' + f.stroke + '" stroke-width="' + f.width + '"/>');
  }

  // 标题条
  if (style.title) {
    const t = style.title;
    const band = t.band || {};
    const bx = dim(band.x ?? 18, w);
    const by = dim(band.y ?? 18, h);
    const bw = dim(band.w ?? 'full', w) - (band.w === 'full' || band.w === undefined ? bx * 2 : 0);
    const bh = dim(band.h ?? 96, h);
    if (band.bottomRule) {
      parts.push('<line x1="' + bx + '" y1="' + (by + bh) + '" x2="' + (bx + bw) + '" y2="' + (by + bh) + '" stroke="' + (band.bottomRule.color || '#111') + '" stroke-width="' + (band.bottomRule.width || 2) + '"/>');
    }
    if (t.left && (opts.title || t.left.text)) {
      const L = t.left;
      const size = L.size || 52;
      const x = anchorX(L.x, w) + (L.x === 'right' ? 0 : 0);
      const y = by + bh / 2 + size * 0.35;
      const txt = opts.title || L.text || '';
      if (asLayer) {
        textLayers.push({ role: 'title', text: txt, x, y, size, font: L.font || 'SimHei', color: L.color || '#111111', bold: L.bold !== false, align: L.anchor === 'middle' ? 'center' : 'left' });
      } else if (L.anchor === 'middle') parts.push('<text x="' + x + '" y="' + y + '" font-size="' + size + '" text-anchor="middle" fill="' + (L.color || '#111') + '" font-family="' + (L.font || 'SimHei') + ',sans-serif"' + (L.bold ? ' font-weight="bold"' : '') + '>' + escapeXml(txt) + '</text>');
      else parts.push('<text x="' + x + '" y="' + y + '" font-size="' + size + '" fill="' + (L.color || '#111') + '" font-family="' + (L.font || 'SimHei') + ',sans-serif"' + (L.bold ? ' font-weight="bold"' : '') + '>' + escapeXml(txt) + '</text>');
    }
    if (t.right && (opts.subtitle || t.right.text)) {
      const R = t.right;
      const size = R.size || 30;
      const txt = opts.subtitle || R.text || '';
      const x = (R.x === 'right' || R.x === undefined) ? w - 38 : anchorX(R.x, w);
      const y = by + bh / 2 + size * 0.35;
      if (asLayer) {
        textLayers.push({ role: 'subtitle', text: txt, x, y, size, font: R.font || 'SimHei', color: R.color || '#111111', bold: Boolean(R.bold), align: 'right' });
      } else {
        parts.push('<text x="' + x + '" y="' + y + '" font-size="' + size + '" text-anchor="end" fill="' + (R.color || '#111') + '" font-family="' + (R.font || 'SimHei') + ',sans-serif"' + (R.bold ? ' font-weight="bold"' : '') + '>' + escapeXml(txt) + '</text>');
      }
    }
  }

  // 主图
  const m = mCfg;
  const mapX = dim(m.x ?? 18, w);
  const mapY = dim(m.y ?? 114, h);
  const mapW = dim(m.w ?? (w - 36), w);
  const autoH = m.h === 'auto';
  const mapH = autoH ? null : dim(m.h ?? 'rest', h, mapY);
  const map = renderMapGroup(entities, {
    width: mapW,
    height: autoH ? undefined : mapH,
    layerStyles: layerStyle,
    maxTexts: opts.maxTexts ?? 400,
    focus: opts.focus !== false,
    background: style.page.background,
  });
  const mapBoxH = autoH && map ? map.height : mapH;
  if (map) {
    parts.push('<defs><clipPath id="mapClip"><rect x="0" y="0" width="' + mapW + '" height="' + mapBoxH + '"/></clipPath></defs>');
    parts.push('<g transform="translate(' + mapX + ',' + mapY + ')" clip-path="url(#mapClip)">' + map.inner + '</g>');
    if (m.border) {
      parts.push('<rect x="' + mapX + '" y="' + mapY + '" width="' + mapW + '" height="' + mapBoxH + '" fill="none" stroke="' + (m.border.color || '#111') + '" stroke-width="' + (m.border.width || 1) + '"/>');
    }
  }

  // 侧栏
  const sb = style.sidebar;
  if (sb) {
    const sbX = dim(sb.x, w);
    const sbY = dim(sb.y, h);
    const sbW = dim(sb.w, w);
    const sbH = dim(sb.h ?? 'rest', h, sbY);
    const cx = sbX + sbW / 2;
    if (sb.rule) parts.push('<line x1="' + sbX + '" y1="' + sbY + '" x2="' + sbX + '" y2="' + (sbY + sbH) + '" stroke="' + sb.rule.color + '" stroke-width="' + sb.rule.width + '"/>');

    if (sb.north) {
      const n = sb.north;
      const ncx = n.cx === 'center' || n.cx === undefined ? cx : Number(n.cx);
      const ny = Number(n.y) || 130;
      const size = Number(n.size) || 78;
      parts.push(northArrow(ncx, ny + size / 2, size));
      parts.push('<text x="' + ncx + '" y="' + (ny - 10) + '" font-size="' + Math.round(size * 0.24) + '" text-anchor="middle" fill="#111" font-family="SimHei,sans-serif">' + escapeXml(n.label || '北') + '</text>');
    }
    if (sb.scaleBar) parts.push(scaleBar(sb.scaleBar, sb.scaleBar.cx === 'center' || sb.scaleBar.cx === undefined ? cx : Number(sb.scaleBar.cx)));

    if (sb.legend) {
      const items = Array.isArray(opts.legendItems) && opts.legendItems.length
        ? opts.legendItems
        : autoLegend(entities, style);
      const cfg = { ...sb.legend, cx };
      const lg = legendBlock(cfg, items);
      parts.push(lg.svg);

      if (sb.note && (opts.note || sb.note.text)) {
        const note = sb.note;
        const text = opts.note || note.text || '';
        const size = note.size || 15;
        const lineH = note.lineHeight || 26;
        const maxChars = Math.floor((sbW - 60) / size);
        const lines = wrapText(text, maxChars);
        const startY = Math.max(note.y || 0, lg.endY + 26);
        if (asLayer) {
          textLayers.push({ role: 'note', text: lines.join('\n'), x: sbX + 30, y: startY, size, font: note.font || 'Microsoft YaHei', color: note.color || '#333333', bold: false, align: 'left', lineHeight: lineH });
        } else {
          lines.forEach((line, i) => {
            parts.push('<text x="' + (sbX + 30) + '" y="' + (startY + i * lineH) + '" font-size="' + size + '" fill="' + (note.color || '#333') + '" font-family="' + (note.font || 'Microsoft YaHei') + ',sans-serif">' + escapeXml(line) + '</text>');
          });
        }
      }
    }
  }

  const svg = [
    '<svg xmlns="http://www.w3.org/2000/svg" width="' + px.width + '" height="' + px.height + '" viewBox="0 0 ' + w + ' ' + h + '">',
    parts.join('\n'),
    '</svg>',
  ].join('\n');

  // 文字层坐标换算到页面像素（参考画布 → px）
  const k = px.width / w;
  const scaledTextLayers = textLayers.map((t) => ({
    ...t,
    x: t.x * k,
    y: t.y * k,
    size: t.size * k,
    lineHeight: t.lineHeight ? t.lineHeight * k : undefined,
  }));

  return {
    svg,
    textLayers: scaledTextLayers,
    width: px.width,
    height: px.height,
    dpi: px.dpi,
    page: { mmW: px.mmW, mmH: px.mmH, size: style.page.size },
    map: map ? { drawn: map.drawn, skippedTexts: map.skippedTexts, anomalies: map.anomalies, focusedOut: map.focusedOut, layers: map.layers } : null,
  };
}

/** 辅助图层不进图例（图框、说明、索引、0 层这些不是分析对象）。 */
const AUX_LAYER = /^(0|defpoints|dxt|dlm\d*)$|图框|图例|说明|索引|标题|边框|指北|比例/i;

/** 自动图例：按图层实体数排序，颜色取自 layerStyles。 */
export function autoLegend(entities, style) {
  const max = (style.legendAuto && style.legendAuto.maxItems) || 8;
  const colors = compileLayerStyles(style, entities.map((e) => e.layer || '0'));
  const stats = layerStats(entities)
    .filter((row) => !AUX_LAYER.test(row.layer) && row.count > 1)
    .slice(0, max);
  return stats.map((row) => {
    const s = colors(row.layer);
    return {
      kind: s.fill !== 'none' ? 'rect' : 'line',
      color: s.fill !== 'none' ? s.fill : s.stroke,
      width: s.width,
      label: row.layer.length > 14 ? row.layer.slice(0, 13) + '…' : row.layer,
    };
  });
}
