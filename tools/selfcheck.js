// tools/selfcheck.js — geo_selfcheck 的 execute。
//
// 插件自己的回归入口：在会话里一句话跑完「依赖 → 解析 → 版式 → 五种输出 → 错误路径」，
// 返回一份带 ✅/❌ 的报告。每次改完插件先跑它，再决定要不要动真数据。
//
// 设计约束：
// - 不依赖外部文件（自带一张最小 DXF），装在谁机器上都能跑；
// - 全部写在系统临时目录，跑完即删；
// - 大文件测试是可选（full: true），因为它慢且吃内存。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseDxf } from '../lib/dxf.js';
import { renderPage } from '../lib/page.js';
import { resolveStyle } from '../lib/style.js';
import { makePdf } from '../lib/pdf.js';
import { makePsd } from '../lib/psd-writer.js';

/** 最小 R12 DXF：3 条线 + 圆 + 文字 + 块引用。 */
const SAMPLE_DXF = [
  '0', 'SECTION', '2', 'HEADER', '0', 'ENDSEC',
  '0', 'SECTION', '2', 'TABLES', '0', 'TABLE', '2', 'LAYER',
  '0', 'LAYER', '2', '道路', '70', 0, '62', 1,
  '0', 'LAYER', '2', '建筑', '70', 0, '62', 3,
  '0', 'ENDTAB', '0', 'ENDSEC',
  '0', 'SECTION', '2', 'BLOCKS',
  '0', 'BLOCK', '2', 'TREE', '10', 0, '20', 0,
  '0', 'LINE', '8', '建筑', '10', 0, '20', 0, '11', 2, '21', 0,
  '0', 'ENDBLK', '0', 'ENDSEC',
  '0', 'SECTION', '2', 'ENTITIES',
  '0', 'LINE', '8', '道路', '10', 0, '20', 0, '11', 10, '21', 10,
  '0', 'LINE', '8', '道路', '10', 10, '20', 10, '11', 20, '21', 0,
  '0', 'LINE', '8', '道路', '10', 20, '20', 0, '11', 0, '21', 0,
  '0', 'CIRCLE', '8', '建筑', '10', 10, '20', 5, '40', 3,
  '0', 'TEXT', '8', '标注', '10', 2, '20', 12, '40', 2.5, '1', '自检样例',
  '0', 'INSERT', '8', '建筑', '2', 'TREE', '10', 5, '20', 5,
  '0', 'ENDSEC', '0', 'EOF',
].join('\n');

function human(n) {
  if (n >= 1048576) return (n / 1048576).toFixed(1) + 'MB';
  if (n >= 1024) return (n / 1024).toFixed(1) + 'KB';
  return n + 'B';
}

export async function execute(args = {}) {
  const rows = [];
  const add = (ok, name, detail) => rows.push({ ok, name, detail });
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'geo-selfcheck-'));
  const t0 = Date.now();

  try {
    // 1) 依赖能不能 import（装漏了会在这里先挂）
    for (const dep of ['ag-psd', '@resvg/resvg-js', 'jpeg-js', 'dwgdxf']) {
      try {
        await import(dep);
        if (process.env.SPATIAL_SC_DEBUG) console.error('[sc] dep', dep, Math.round(process.memoryUsage().rss / 1048576) + 'MB');
        add(true, '依赖 ' + dep, '');
      } catch (e) {
        add(false, '依赖 ' + dep, String(e?.message || e).slice(0, 80));
      }
    }
    // @napi-rs/canvas 是 vendored 的可选依赖：优先用正式安装，回退包内副本
    try {
      await import('@napi-rs/canvas');
      add(true, '依赖 @napi-rs/canvas', '');
    } catch {
      try {
        await import('../vendor/node_modules/@napi-rs/canvas/index.js');
        add(true, '依赖 @napi-rs/canvas', 'vendor 副本');
      } catch (e2) {
        add(false, '依赖 @napi-rs/canvas', String(e2?.message || e2).slice(0, 80));
      }
    }

    // 2) 解析
    const dxfPath = path.join(tmp, 'sample.dxf');
    fs.writeFileSync(dxfPath, SAMPLE_DXF, 'utf8');
    const parsed = parseDxf(SAMPLE_DXF);
    const lineCount = parsed.stats.byType.LINE || 0;
    add(lineCount >= 3 && parsed.layers.length >= 2 && parsed.blocks.size >= 1, 'DXF 解析',
      '实体 ' + parsed.entities.length + ' / 图层 ' + parsed.layers.length + ' / 块 ' + parsed.blocks.size);

    // 3) 版式
    const style = resolveStyle('planning-a1');
    // 自检用小纸（A5 横 72dpi ≈ 567×400），别让测试本身把内存吃掉
    style.page = { size: 'custom', mmW: 200, mmH: 141, dpi: 72, background: '#ffffff' };
    const page = renderPage(parsed.entities, {
      style, title: '自检标题', subtitle: '00-0 自检图名', note: '说明：自检样例。',
    });
    if (process.env.SPATIAL_SC_DEBUG) console.error('[sc] after renderPage', page.width + 'x' + page.height, 'svg', page.svg.length, '|', page.svg.slice(0, 100).replace(/\n/g, ' '), Math.round(process.memoryUsage().rss / 1048576) + 'MB');
    add(page.svg.startsWith('<svg') && page.svg.includes('自检标题'), '版式渲染',
      'SVG ' + human(Buffer.byteLength(page.svg)) + ' / ' + page.width + '×' + page.height);

    // 4) 输出走公开工具（worker 隔离的真实链路），不再自建 resvg
    const mapMod = await import('./map-export.js');
    const base = path.join(tmp, 'o');
    const outs = [['png', 'PNG 输出'], ['jpg', 'JPG 输出'], ['pdf', 'PDF 输出'], ['psd', 'PSD 输出']];
    for (const [fmt, label] of outs) {
      try {
        const r = await mapMod.execute({
          path: dxfPath, output: base, style: 'planning-a1', dpi: 36, format: fmt,
          title: '自检标题', subtitle: '00-0 自检图名',
        });
        const target = base + '.' + fmt;
        const size = fs.existsSync(target) ? fs.statSync(target).size : 0;
        let ok = size > 500;
        let detail = human(size);
        if (fmt === 'pdf') ok = ok && fs.readFileSync(target).subarray(0, 8).toString('latin1') === '%PDF-1.4';
        if (fmt === 'psd') {
          const { readPsd } = await import('ag-psd');
          const back = readPsd(fs.readFileSync(target), { skipCompositeImageData: true, skipThumbnail: true });
          ok = ok && back.children.some((c) => c.text);
          detail = back.children.length + ' 层 / ' + detail;
        }
        add(ok, label, detail);
      } catch (e) {
        add(false, label, String(e?.message || e).slice(0, 80));
      }
    }

    // 5) GIS：GeoJSON 读取 + 属性查询
    const gjPath = path.join(tmp, 'a.geojson');
    fs.writeFileSync(gjPath, JSON.stringify({
      type: 'FeatureCollection',
      features: [
        { type: 'Feature', properties: { name: 'A', kind: 'R2' }, geometry: { type: 'Polygon', coordinates: [[[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]]] } },
        { type: 'Feature', properties: { name: 'B', kind: 'C1' }, geometry: { type: 'Polygon', coordinates: [[[20, 0], [30, 0], [30, 10], [20, 10], [20, 0]]] } },
      ],
    }));
    const gisR = await (await import('./gis-read.js')).execute({ path: gjPath });
    add(/要素：2/.test(gisR.text), 'GIS 读取', 'GeoJSON 2 要素');
    const gisQ = await (await import('./gis-query.js')).execute({ path: gjPath, where: [{ col: 'kind', op: 'eq', value: 'R2' }] });
    add(/命中 1/.test(gisQ.text), 'GIS 查询', '属性过滤命中 1');
    const gisS = await (await import('./gis-summary.js')).execute({ path: gjPath, groupBy: 'kind' });
    add(/2 类 \/ 2 个要素/.test(gisS.text), 'GIS 汇总', '按 kind 分 2 类');
    const gisB = await (await import('./gis-buffer.js')).execute({ path: gjPath, distance: 2 });
    add(/缓冲后/.test(gisB.text), 'GIS 缓冲', '面外扩 2');
    const gisO = await (await import('./gis-overlay.js')).execute({ a: gjPath, b: gjPath, op: 'intersect' });
    add(/结果 2 个面/.test(gisO.text), 'GIS 叠加', '自身相交 2 个面');

    // 6) 错误路径（应该返回可读错误，不是崩）
    let errText = '';
    try {
      await (await import('./dxf-info.js')).execute({ path: path.join(tmp, 'nope.dxf') });
    } catch (e) {
      errText = String(e?.message || e);
    }
    add(/不存在/.test(errText), '错误路径', errText.slice(0, 40) || '没有抛错');

    // 7) 可选：大文件（full）
    if (args.full) {
      const big = process.env.GEO_BIG_DXF || path.join(tmp, 'big.dxf');
      if (fs.existsSync(big)) {
        const t = Date.now();
        const r2 = await (await import('./dxf-info.js')).execute({ path: big });
        add(r2.text.includes('实体'), '大文件解析（48MB）', (Date.now() - t) + 'ms');
      } else {
        add(true, '大文件解析', '跳过（没有样例文件）');
      }
    }
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
  }

  const pass = rows.filter((r) => r.ok).length;
  const lines = [];
  lines.push('geo-toolkit 自检｜' + pass + '/' + rows.length + ' 通过｜' + (Date.now() - t0) + 'ms');
  for (const r of rows) lines.push((r.ok ? '✅ ' : '❌ ') + r.name + (r.detail ? '：' + r.detail : ''));
  if (pass < rows.length) lines.push('有失败项 —— 先把上面的 ❌ 逐条修掉，再动真实数据。');
  else lines.push('全部通过。改完插件先跑这一遍，再跑 test/smoke.test.mjs。');
  return { text: lines.join('\n') };
}
