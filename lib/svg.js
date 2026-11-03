// dsh-geo-toolkit / lib/svg.js
// 地图内容渲染：把实体画成 SVG 片段（不含页面框架）。
// 版式（标题、图例、指北针、比例尺、图框）在 lib/page.js，两者分开。
//
// 坐标映射只有一处：
//   X(x) = offX + (x - ox) * scale
//   Y(y) = offY + (oy - y) * scale      oy = bbox.maxY + pad（CAD 的 Y 向上，SVG 向下）

import { bboxOf, isSaneEntity, cleanDxfText, mainCluster } from './geo.js';

const PALETTE = [
  '#1f77b4', '#d62728', '#2ca02c', '#ff7f0e', '#9467bd',
  '#8c564b', '#e377c2', '#17becf', '#bcbd22', '#7f7f7f',
  '#aec7e8', '#ffbb78', '#98df8a', '#ff9896', '#c5b0d5',
];

/** 图层 → 颜色（未提供 layerStyles 时的兜底）。 */
function makePalette(layers) {
  const map = new Map();
  let i = 0;
  for (const l of layers) map.set(l, PALETTE[i++ % PALETTE.length]);
  return (layer) => map.get(layer || '0') || '#333333';
}

/** 圆弧采样成折线点（角度为度，CAD 逆时针）。 */
function arcPoints(cx, cy, r, startDeg, endDeg, steps = 20) {
  let a0 = startDeg * Math.PI / 180;
  let a1 = endDeg * Math.PI / 180;
  while (a1 <= a0) a1 += Math.PI * 2;
  const pts = [];
  for (let i = 0; i <= steps; i++) {
    const a = a0 + (a1 - a0) * i / steps;
    pts.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
  }
  return pts;
}

/**
 * 渲染地图内容为 SVG 片段。
 * @param {Array} entities
 * @param {object} opts { width, height?, focus=true, maxTexts=400, layerStyles?, background?, drawText=true }
 * @returns {object|null}
 */
export function renderMapGroup(entities, opts = {}) {
  if (!entities || entities.length === 0) return null;
  const sane = entities.filter(isSaneEntity);
  const anomalies = entities.length - sane.length;
  const focused = opts.focus === false ? { kept: sane, dropped: [] } : mainCluster(sane);
  const bbox = bboxOf(focused.kept);
  if (!bbox) return null;

  const reqW = Math.max(100, Math.round(opts.width || 1600));
  const span = Math.max(bbox.width, bbox.height, 1e-9);
  const pad = span * 0.02;
  const worldW = bbox.width + pad * 2;
  const worldH = bbox.height + pad * 2;

  let scale;
  let offX = 0;
  let offY = 0;
  let outW;
  let outH;
  if (opts.height) {
    const reqH = Math.max(60, Math.round(opts.height));
    scale = Math.min(reqW / worldW, reqH / worldH);
    outW = reqW;
    outH = reqH;
    offX = (reqW - worldW * scale) / 2;
    offY = (reqH - worldH * scale) / 2;
  } else {
    scale = reqW / worldW;
    outW = reqW;
    outH = Math.max(60, Math.round(worldH * scale));
  }

  const ox = bbox.minX - pad;
  const oy = bbox.maxY + pad;
  const X = (x) => offX + (x - ox) * scale;
  const Y = (y) => offY + (oy - y) * scale;

  const layers = [...new Set(focused.kept.map((e) => e.layer || '0'))];
  const fallbackColor = makePalette(layers);
  const styleOf = typeof opts.layerStyles === 'function' ? opts.layerStyles : null;

  const parts = [];
  const texts = [];
  const maxTexts = opts.maxTexts ?? 400;
  let skippedTexts = 0;
  let drawn = 0;
  const ptsStr = (pts) => pts.map((p) => X(p[0]).toFixed(2) + ',' + Y(p[1]).toFixed(2)).join(' ');

  for (const e of focused.kept) {
    const s = styleOf ? styleOf(e.layer) : { fill: 'none', stroke: fallbackColor(e.layer), width: 1, fillOpacity: 1 };
    const fill = s.fill === 'none' ? 'none' : s.fill;
    const fillAttr = fill === 'none' ? 'fill="none"' : 'fill="' + fill + '" fill-opacity="' + (s.fillOpacity ?? 1) + '"';
    const stroke = 'stroke="' + (s.stroke || '#333333') + '" stroke-width="' + (s.width || 1) + '"';
    switch (e.type) {
      case 'LINE':
      case 'LWPOLYLINE':
      case 'POLYLINE': {
        const pts = e.points || [];
        if (pts.length < 2) break;
        const closed = e.closed || (s.closePolygons && pts.length > 2);
        const tag = closed ? 'polygon' : 'polyline';
        const f = closed ? fillAttr : 'fill="none"';
        parts.push('<' + tag + ' points="' + ptsStr(pts) + '" ' + f + ' ' + stroke + ' stroke-linejoin="round"/>');
        drawn++;
        break;
      }
      case 'CIRCLE':
        parts.push('<circle cx="' + X(e.center[0]).toFixed(2) + '" cy="' + Y(e.center[1]).toFixed(2) + '" r="' + (e.r * scale).toFixed(2) + '" ' + fillAttr + ' ' + stroke + '/>');
        drawn++;
        break;
      case 'ARC': {
        const pts = arcPoints(e.center[0], e.center[1], e.r, e.start, e.end);
        parts.push('<polyline points="' + ptsStr(pts) + '" fill="none" ' + stroke + ' stroke-linejoin="round"/>');
        drawn++;
        break;
      }
      case 'SOLID':
        parts.push('<polygon points="' + ptsStr(e.points) + '" ' + fillAttr + ' ' + stroke + '/>');
        drawn++;
        break;
      case 'TEXT':
      case 'MTEXT': {
        if (opts.drawText === false) break;
        const t = cleanDxfText(e.text);
        if (!t) break;
        if (texts.length >= maxTexts) { skippedTexts++; break; }
        const size = Math.max(4, Math.min(120, (e.height || span * 0.006) * scale));
        texts.push('<text x="' + X(e.pos[0]).toFixed(2) + '" y="' + Y(e.pos[1]).toFixed(2) + '" font-size="' + size.toFixed(1) + '" fill="' + (s.stroke || '#333333') + '" font-family="Microsoft YaHei,SimHei,sans-serif">' + escapeXml(t) + '</text>');
        drawn++;
        break;
      }
      case 'INSERT': {
        const x = X(e.pos[0]);
        const y = Y(e.pos[1]);
        parts.push('<path d="M' + (x - 2).toFixed(1) + ' ' + y.toFixed(1) + 'h4M' + x.toFixed(1) + ' ' + (y - 2).toFixed(1) + 'v4" stroke="#c00" stroke-width="0.7" fill="none"/>');
        drawn++;
        break;
      }
      case 'POINT':
        parts.push('<circle cx="' + X(e.pos[0]).toFixed(2) + '" cy="' + Y(e.pos[1]).toFixed(2) + '" r="1.4" fill="' + (s.stroke || '#333333') + '"/>');
        drawn++;
        break;
      default:
        break;
    }
  }

  const bg = opts.background ? '<rect x="0" y="0" width="' + outW + '" height="' + outH + '" fill="' + opts.background + '"/>' : '';
  const inner = bg + parts.join('') + texts.join('');
  return { inner, width: outW, height: outH, drawn, skippedTexts, anomalies, focusedOut: focused.dropped.length, layers: layers.length, bbox };
}

/** 兼容旧调用：整张 SVG（无版式）。 */
export function renderSvg(entities, opts = {}) {
  const r = renderMapGroup(entities, { ...opts, focus: opts.focus !== false });
  if (!r) return null;
  const title = opts.title ? '<text x="12" y="22" font-size="14" fill="#555" font-family="Microsoft YaHei,SimHei,sans-serif">' + escapeXml(opts.title) + '</text>' : '';
  const svg = [
    '<svg xmlns="http://www.w3.org/2000/svg" width="' + r.width + '" height="' + r.height + '" viewBox="0 0 ' + r.width + ' ' + r.height + '">',
    '<rect width="100%" height="100%" fill="#ffffff"/>',
    title,
    r.inner,
    '</svg>',
  ].join('\n');
  return { svg, ...r };
}

export function escapeXml(s) {
  return String(s).replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' }[c]));
}
