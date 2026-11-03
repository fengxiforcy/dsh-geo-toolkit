// dsh-geo-toolkit / lib/style.js
// 版式：加载 JSON、补默认值、按图层规则匹配样式。
//
// 版式坐标一律用「参考画布」（style.canvas，默认 1800×1272），渲染时整体缩放到目标像素。
// 这样量图（我在缩略图上量的坐标）和换尺寸（A1/A3/300dpi/150dpi）互不干扰。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SANE_LIMIT } from './geo.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const BUILTIN_DIR = path.join(HERE, '..', 'styles');

/** 内置版式名 → 文件。 */
export function listBuiltinStyles() {
  try {
    return fs.readdirSync(BUILTIN_DIR).filter((f) => f.endsWith('.json')).map((f) => f.replace(/\.json$/, ''));
  } catch {
    return [];
  }
}

/**
 * 解析 style 参数：内置名 / 文件路径 / 内联对象。
 * @param {string|object|undefined} style
 * @returns {object} 已补默认值的版式
 */
export function resolveStyle(style) {
  let raw;
  if (!style) {
    raw = loadFile(path.join(BUILTIN_DIR, 'planning-a1.json'));
  } else if (typeof style === 'object') {
    raw = style;
  } else if (typeof style === 'string') {
    const builtin = listBuiltinStyles().includes(style);
    if (builtin) raw = loadFile(path.join(BUILTIN_DIR, style + '.json'));
    else if (fs.existsSync(style)) raw = loadFile(style);
    else throw new Error('找不到版式「' + style + '」：内置有 ' + listBuiltinStyles().join('、') + '；也可以给 .json 文件路径');
  } else {
    throw new Error('style 参数类型不对（应为内置名 / 路径 / 对象）');
  }
  return normalize(raw);
}

function loadFile(p) {
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

/** 补默认值 + 基本校验。 */
export function normalize(raw) {
  if (!raw || typeof raw !== 'object') throw new Error('版式内容为空');
  const canvas = { width: 1800, height: 1272, ...(raw.canvas || {}) };
  const page = { size: 'A1', orientation: 'landscape', dpi: 300, background: '#ffffff', ...(raw.page || {}) };
  if (!['A0', 'A1', 'A2', 'A3', 'A4', 'custom'].includes(page.size)) throw new Error('page.size 只支持 A0–A4 或 custom');
  if (page.size === 'custom' && (!page.mmW || !page.mmH)) throw new Error('自定义纸张需要 page.mmW / page.mmH');
  const st = {
    canvas,
    page,
    frame: raw.frame || null,
    title: raw.title || null,
    map: raw.map || { x: 18, y: 114, w: canvas.width - 36, h: 'rest' },
    sidebar: raw.sidebar || null,
    layerStyles: Array.isArray(raw.layerStyles) ? raw.layerStyles : [],
    palette: Array.isArray(raw.palette) ? raw.palette : ['#333333'],
    legendAuto: raw.legendAuto || { enabled: false },
  };
  return st;
}

/** 纸张 mm 尺寸。 */
const PAPER = { A0: [841, 1189], A1: [594, 841], A2: [420, 594], A3: [297, 420], A4: [210, 297] };

/** 算输出像素：按纸张、dpi、横竖。 */
export function pagePixels(style) {
  let mmW;
  let mmH;
  if (style.page.size === 'custom') {
    mmW = Number(style.page.mmW);
    mmH = Number(style.page.mmH);
  } else {
    const [w, h] = PAPER[style.page.size] || PAPER.A1;
    const swap = style.page.orientation === 'landscape';
    mmW = swap ? Math.max(w, h) : Math.min(w, h);
    mmH = swap ? Math.min(w, h) : Math.max(w, h);
  }
  const dpi = Math.max(72, Math.min(600, Number(style.page.dpi) || 300));
  return {
    width: Math.round(mmW / 25.4 * dpi),
    height: Math.round(mmH / 25.4 * dpi),
    dpi,
    mmW,
    mmH,
  };
}

/**
 * 编译图层规则：返回 (layer) => {fill, stroke, width, fillOpacity}。
 *
 * fillAuto 的颜色必须**按图层名确定**，不能按出现顺序——主图渲染和图例生成是两次独立调用，
 * 按顺序分配会让「图例里的红色」在主图上变成绿色（实测踩过）。
 * 所以颜色 = 全部图层排序后的索引，两处传同一份 layers 就一致。
 */
export function compileLayerStyles(style, layers = []) {
  const order = [...new Set(layers.map((l) => l || '0'))].sort();
  const colorOf = new Map();
  order.forEach((l, i) => colorOf.set(l, style.palette[i % style.palette.length]));
  const rules = style.layerStyles.map((r) => ({
    re: new RegExp(r.match || '.*'),
    fill: r.fill ?? 'none',
    fillAuto: Boolean(r.fillAuto),
    fillOpacity: r.fillOpacity ?? 1,
    stroke: r.stroke ?? '#333333',
    width: r.width ?? 1,
  }));
  return (layer) => {
    const name = layer || '0';
    const hit = rules.find((r) => r.re.test(name));
    if (!hit) return { fill: 'none', stroke: '#333333', width: 1, fillOpacity: 1 };
    if (hit.fillAuto) {
      return { fill: colorOf.get(name) || style.palette[0], stroke: hit.stroke, width: hit.width, fillOpacity: hit.fillOpacity };
    }
    return { fill: hit.fill, stroke: hit.stroke, width: hit.width, fillOpacity: hit.fillOpacity };
  };
}
