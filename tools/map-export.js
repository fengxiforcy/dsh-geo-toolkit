// tools/map-export.js — geo_map_export 的 execute。
// 版式（style）+ 内容（DXF 实体）→ SVG/PNG/JPG/PDF。
// PNG/JPG/PDF 走 LibreOffice（本机已装，转 SVG 稳定）；SVG 是唯一矢量源。

import fs from 'node:fs';
import path from 'node:path';
import { parseDxf, explodeInserts } from '../lib/dxf.js';
import { readDxfText, nowMs, humanBytes } from '../lib/io.js';
import { renderPage } from '../lib/page.js';
import { resolveStyle, listBuiltinStyles } from '../lib/style.js';
import { runHeavy, assertMemoryHeadroom } from '../lib/heavy.js';

function replaceExt(p, ext) {
  return p.replace(/\.[^.\\/]+$/, '') + '.' + ext;
}

export async function execute(args) {
  const input = args?.path;
  if (!input) throw new Error('path 不能为空');
  if (!fs.existsSync(input)) throw new Error('文件不存在：' + input);

  const format = String(args.format || 'svg').toLowerCase();
  if (!['svg', 'png', 'jpg', 'jpeg', 'pdf', 'psd'].includes(format)) {
    throw new Error('format 只支持 svg / png / jpg / pdf / psd');
  }

  const style = resolveStyle(args.style);
  if (args.dpi) style.page.dpi = Number(args.dpi);

  const layers = Array.isArray(args.layer) ? args.layer : (args.layer ? [args.layer] : null);
  const t0 = nowMs();
  const { text } = readDxfText(input);
  const parsed = parseDxf(text);
  let entities = parsed.entities;
  if (args.explode !== false) entities = explodeInserts(parsed);
  if (layers && layers.length) {
    const set = new Set(layers);
    entities = entities.filter((e) => set.has(e.layer));
  }

  const wantPsd = format === 'psd';
  const page = renderPage(entities, {
    style,
    title: args.title,
    subtitle: args.subtitle,
    note: args.note,
    maxTexts: Number(args.maxTexts) || 400,
    focus: args.focus !== false,
    textAsLayers: wantPsd,
  });

  // output 可以给不带扩展名的基名，也可以给带 .svg/.png/.jpg/.pdf 的完整名；统一去掉旧扩展名再拼
  const outBase = args.output
    ? path.join(path.dirname(args.output), path.basename(args.output).replace(/\.(svg|png|jpe?g|pdf|psd)$/i, ''))
    : path.join(path.dirname(input), path.basename(input).replace(/\.dxf$/i, ''));
  const svgPath = outBase + '.svg';
  fs.writeFileSync(svgPath, page.svg, 'utf8');

  const lines = [];
  lines.push('分析图已导出：' + svgPath);
  lines.push('版式：' + (typeof args.style === 'string' ? args.style : 'planning-a1（默认）') + '｜页面 ' + page.page.size + ' 横版 ' + page.page.mmW + '×' + page.page.mmH + 'mm @' + page.dpi + 'dpi = ' + page.width + '×' + page.height + 'px');
  if (page.map) {
    const extra = [];
    if (page.map.skippedTexts) extra.push('跳过文字 ' + page.map.skippedTexts);
    if (page.map.anomalies) extra.push('坐标异常 ' + page.map.anomalies);
    if (page.map.focusedOut) extra.push('聚焦剔除 ' + page.map.focusedOut);
    lines.push('主图：实体 ' + page.map.drawn + ' 条｜图层 ' + page.map.layers + ' 个' + (extra.length ? '｜' + extra.join('｜') : ''));
  }
  lines.push('SVG ' + humanBytes(fs.statSync(svgPath).size) + '｜耗时 ' + (nowMs() - t0).toFixed(0) + ' ms');

  if (format !== 'svg') {
    const ext = format === 'jpeg' ? 'jpg' : format;
    const target = replaceExt(svgPath, ext);
    const t1 = nowMs();
    // 重活全部丢进 worker：native 内存有上限、超时强杀、结束即回收（见 lib/heavy.js）
    const rssBefore = assertMemoryHeadroom();
    const isPsd = format === 'psd';
    const result = await runHeavy(isPsd
      ? { type: 'psd', svg: page.svg, width: page.width, dpi: page.dpi, background: style.page.background, textLayers: page.textLayers || [] }
      : { type: 'raster', svg: page.svg, width: page.width, format: ext, mmW: page.page.mmW, mmH: page.page.mmH, title: args.title },
    { timeoutMs: 180000 });
    fs.writeFileSync(target, result.buffer);
    if (!fs.existsSync(target)) throw new Error('转 ' + format.toUpperCase() + ' 没有产出文件：' + target);
    lines.push('输出：' + target + '（' + humanBytes(fs.statSync(target).size) + '，worker 光栅化 ' + (nowMs() - t1).toFixed(0) + ' ms，' + result.width + '×' + result.height + '，主进程 RSS ' + rssBefore + 'MB）');
  }

  lines.push('内置版式：' + listBuiltinStyles().join('、'));
  return { text: lines.join('\n') };
}
