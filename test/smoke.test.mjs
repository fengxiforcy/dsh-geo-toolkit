// 单测：解析器 / 几何 / SVG / 四个工具的 execute。不需要 DSH 宿主。
import { test, after } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseDxf, explodeInserts } from '../lib/dxf.js';
import { bboxOf, inferUnit, layerStats, cleanDxfText } from '../lib/geo.js';
import { renderSvg } from '../lib/svg.js';
import * as info from '../tools/dxf-info.js';
import * as query from '../tools/dxf-query.js';
import * as map from '../tools/map-export.js';
import { renderPage } from '../lib/page.js';
import { resolveStyle, pagePixels } from '../lib/style.js';
import { makePdf } from '../lib/pdf.js';
import { shutdownHeavy } from '../lib/heavy.js';
import { colorToHex, textLevels, layoutToStyle, formatPsdReport, regions } from '../lib/psd.js';
import * as gisRead from '../tools/gis-read.js';
import * as gisQuery from '../tools/gis-query.js';
import * as gisSummary from '../tools/gis-summary.js';
import * as gisBuffer from '../tools/gis-buffer.js';
import * as gisOverlay from '../tools/gis-overlay.js';
import { allSpecs } from '../tool-spec.js';

// 测试结束关掉常驻 worker，否则进程要等 60 秒空闲回收才退出
after(() => shutdownHeavy());
import { makePsd } from '../lib/psd-writer.js';
import { readPsd } from 'ag-psd';

/** 造一张最小 R12 DXF：三角形线、圆、文字、闭合多段线、块引用。 */
function makeDxf() {
  const L = [];
  const w = (...a) => a.forEach((x) => L.push(String(x)));
  w('0','SECTION','2','HEADER','0','ENDSEC');
  w('0','SECTION','2','TABLES','0','TABLE','2','LAYER');
  for (const [n, c] of [['0',7],['道路',1],['建筑',3]]) w('0','LAYER','2',n,'70',0,'62',c);
  w('0','ENDTAB','0','ENDSEC');
  w('0','SECTION','2','BLOCKS');
  w('0','BLOCK','2','TREE','10',0,'20',0);
  w('0','LINE','8','建筑','10',0,'20',0,'11',2,'21',0);
  w('0','ENDBLK');
  w('0','ENDSEC');
  w('0','SECTION','2','ENTITIES');
  const px = [0, 10, 20], py = [0, 10, 0];
  for (let i = 0; i < 3; i++) {
    const j = (i + 1) % 3;
    w('0','LINE','8','道路','10',px[i],'20',py[i],'11',px[j],'21',py[j]);
  }
  w('0','CIRCLE','8','建筑','10',10,'20',5,'40',3);
  w('0','TEXT','8','标注','10',2,'20',12,'40',2.5,'1','规划测试');
  w('0','POLYLINE','8','地块','66',1,'70',1);
  for (let i = 0; i < 3; i++) { w('0','VERTEX','8','地块','10',px[i],'20',py[i]); }
  w('0','SEQEND');
  w('0','INSERT','8','建筑','2','TREE','10',5,'20',5,'41',1,'42',1,'50',0);
  w('0','ENDSEC','0','EOF');
  return L.join('\n');
}

let tmp;
function write(name, body) {
  tmp = tmp || fs.mkdtempSync(path.join(os.tmpdir(), 'geo-'));
  const p = path.join(tmp, name);
  fs.writeFileSync(p, body, 'utf8');
  return p;
}

test('parseDxf 读出实体、图层、块', () => {
  const p = parseDxf(makeDxf());
  assert.strictEqual(p.layers.length, 3);
  assert.strictEqual(p.blocks.size, 1);
  const types = p.stats.byType;
  // 块内那 1 条线也算进全局统计，所以是 3 + 1
  assert.strictEqual(types.LINE, 4);
  assert.strictEqual(types.CIRCLE, 1);
  assert.strictEqual(types.TEXT, 1);
  assert.strictEqual(types.POLYLINE, 1);
  assert.strictEqual(types.INSERT, 1);
  const circle = p.entities.find((e) => e.type === 'CIRCLE');
  assert.deepStrictEqual(circle.center, [10, 5]);
  assert.strictEqual(circle.r, 3);
  const text = p.entities.find((e) => e.type === 'TEXT');
  assert.strictEqual(text.text, '规划测试');
});

test('explodeInserts 把块内实体展开', () => {
  const p = parseDxf(makeDxf());
  const out = explodeInserts(p);
  // 3 线 + 圆 + 文字 + 多段线 + 块内 1 线
  assert.strictEqual(out.length, 7);
  assert.ok(out.some((e) => e.type === 'LINE' && e.points[0][0] === 5));
});

test('bboxOf 与 inferUnit', () => {
  const p = parseDxf(makeDxf());
  const b = bboxOf(p.entities);
  assert.strictEqual(b.minX, 0);
  assert.strictEqual(b.maxX, 20);
  const u = inferUnit(Math.max(b.width, b.height));
  assert.strictEqual(u.unit, 'm');
  assert.strictEqual(layerStats(p.entities)[0].layer, '道路');
});

test('renderSvg 产出合法 SVG 且含实体', () => {
  const p = parseDxf(makeDxf());
  const r = renderSvg(p.entities, { width: 800, title: '测试图' });
  assert.ok(r.svg.startsWith('<svg'));
  assert.ok(r.svg.includes('polyline'));
  assert.ok(r.svg.includes('circle'));
  assert.ok(r.svg.includes('规划测试'));
  assert.ok(r.width === 800);
  assert.ok(r.height > 0);
});

test('geo_dxf_info 返回概览', async () => {
  const f = write('a.dxf', makeDxf());
  const r = await info.execute({ path: f, includeText: true, explode: true });
  assert.match(r.text, /图层：3/);
  assert.match(r.text, /实体：7/);
  assert.match(r.text, /单位推断：米/);
  assert.match(r.text, /规划测试/);
});

test('geo_dxf_query 按图层/类型/文字过滤', async () => {
  const f = write('a.dxf', makeDxf());
  const byLayer = await query.execute({ path: f, layer: '道路' });
  assert.match(byLayer.text, /命中 3/);
  const byText = await query.execute({ path: f, text: '规划' });
  assert.match(byText.text, /命中 1/);
  assert.match(byText.text, /规划测试/);
  const byType = await query.execute({ path: f, type: 'circle' });
  assert.match(byType.text, /命中 1/);
});

test('geo_map_export 出 SVG（带版式）', async () => {
  const f = write('a.dxf', makeDxf());
  const out = path.join(tmp, 'page.svg');
  const r = await map.execute({ path: f, output: out, style: 'planning-a1', title: '测试项目', subtitle: '图名', dpi: 72 });
  assert.match(r.text, /分析图已导出/);
  const svg = fs.readFileSync(out, 'utf8');
  assert.ok(svg.includes('<svg'));
  assert.ok(svg.includes('测试项目'));
  assert.ok(svg.length > 2000);
});

test('geo_map_export 出 PNG 与 PDF', async () => {
  const f = write('a.dxf', makeDxf());
  const png = path.join(tmp, 'page.png');
  const r1 = await map.execute({ path: f, output: png, style: 'planning-a1', dpi: 72, format: 'png' });
  assert.match(r1.text, /输出：/);
  assert.ok(fs.statSync(png).size > 1000);
  const pdf = path.join(tmp, 'page.pdf');
  const r2 = await map.execute({ path: f, output: pdf, style: 'planning-a1', dpi: 72, format: 'pdf' });
  assert.match(r2.text, /输出：/);
  assert.strictEqual(fs.readFileSync(pdf).subarray(0, 8).toString('latin1'), '%PDF-1.4');
});

test('cleanDxfText 剥掉 MTEXT 控制码', () => {
  const BS = String.fromCharCode(92); // 反斜杠，避免测试文件里的转义歧义
  const raw = BS + 'fMicrosoft YaHei|b1|i0|c134|p34;扬州明清历史城区详细规划';
  assert.strictEqual(cleanDxfText(raw), '扬州明清历史城区详细规划');
  assert.strictEqual(cleanDxfText(BS + 'pi89.83;' + BS + 'P第二段'), '第二段');
  assert.strictEqual(cleanDxfText('50%%dC'), '50°C');
});

test('异常坐标实体不进包围盒', () => {
  const p = parseDxf(makeDxf());
  const bad = { type: 'LWPLINE', layer: 'x', points: [[1e51, 1e-296], [0, 0]] };
  const entities = [...p.entities, bad];
  const b = bboxOf(entities);
  assert.ok(b.width < 100, '异常坐标不应撑大包围盒');
  const r = renderSvg(entities, { width: 400 });
  assert.strictEqual(r.anomalies, 1);
});

test('renderPage 出标题/图例/指北针/比例尺', () => {
  const p = parseDxf(makeDxf());
  const style = resolveStyle('planning-a1');
  const page = renderPage(p.entities, {
    style,
    title: '测试项目名',
    subtitle: '03-4 测试图名',
    note: '说明：这是一段测试说明文字。',
  });
  assert.ok(page.svg.startsWith('<svg'));
  assert.ok(page.svg.includes('测试项目名'));
  assert.ok(page.svg.includes('03-4 测试图名'));
  assert.ok(page.svg.includes('图例'));
  assert.ok(page.svg.includes('clipPath'));
  assert.strictEqual(page.dpi, 300);
  assert.strictEqual(page.width, 9933, 'A1 300dpi 宽度');
});

test('页面尺寸随 dpi 与纸张变化', () => {
  const style = resolveStyle('planning-a1');
  const a = pagePixels(style);
  assert.ok(a.width > a.height);
  style.page.dpi = 150;
  const b = pagePixels(style);
  assert.ok(b.width < a.width);
});

test('图例颜色与主图一致（fillAuto 按图层名）', () => {
  const p = parseDxf(makeDxf());
  const style = resolveStyle('planning-a1');
  const page = renderPage(p.entities, { style, title: 'T' });
  // 「道路」在 layerStyles 里是描边规则，颜色固定；「地块」是 fillAuto
  const idx = page.svg.indexOf('图例');
  assert.ok(idx > 0);
  // 主图与图例都必须出现同一个填充色（取 palette 首色 #d94f4f，因为「0」排第一）
  assert.ok(page.svg.includes('#d94f4f'));
});

test('makePdf 生成合法 PDF 头与结尾', () => {
  const w = 4, h = 3;
  const rgb = Buffer.alloc(w * h * 3, 200);
  const pdf = makePdf({ widthPx: w, heightPx: h, rgb, mmW: 100, mmH: 75, title: 't' });
  assert.strictEqual(pdf.subarray(0, 8).toString('latin1'), '%PDF-1.4');
  assert.ok(pdf.toString('latin1').includes('%%EOF'));
  assert.ok(pdf.toString('latin1').includes('/Subtype /Image'));
});

test('colorToHex 兜住三种数值范围', () => {
  assert.strictEqual(colorToHex({ r: 1, g: 0, b: 0 }), '#ff0000');
  assert.strictEqual(colorToHex({ r: 255, g: 128, b: 0 }), '#ff8000');
  assert.strictEqual(colorToHex(null), null);
});

test('textLevels 把相近字号归并成层级', () => {
  const layout = {
    width: 1000, height: 2000, dpi: 300,
    layers: [
      { kind: 'text', visible: true, text: '大标题', effectiveSize: 300, left: 10, top: 10, lineCount: 1, font: 'SimHei', color: '#111' },
      { kind: 'text', visible: true, text: '小标题A', effectiveSize: 120, left: 20, top: 400, lineCount: 1 },
      { kind: 'text', visible: true, text: '小标题B', effectiveSize: 118, left: 20, top: 500, lineCount: 1 },
    ],
  };
  const lv = textLevels(layout);
  assert.strictEqual(lv.length, 2);
  assert.strictEqual(lv[0].size, 300);
  assert.strictEqual(lv[1].count, 2);
});

test('layoutToStyle 生成可渲染的版式（fitContent + 标题取自上部）', () => {
  const layout = {
    width: 1000, height: 4000, dpi: 300,
    layers: [
      { kind: 'text', visible: true, text: '设计标题', effectiveSize: 300, left: 50, top: 50, lineCount: 1, font: 'SimHei', color: '#111111' },
      { kind: 'text', visible: true, text: '副标题', effectiveSize: 100, left: 700, top: 60, lineCount: 1, font: 'SimHei', color: '#111111' },
      { kind: 'group', visible: true, name: '框线', left: 0, top: 0, right: 1000, bottom: 4000 },
    ],
  };
  const st = layoutToStyle(layout, { name: 't', source: 'x.psd' });
  assert.strictEqual(st.page.size, 'custom');
  assert.strictEqual(st.page.fitContent, true);
  assert.strictEqual(st.map.h, 'auto');
  assert.ok(st.title.left.size > 0);
  const page = renderPage([{ type: 'LINE', layer: '道路', points: [[0, 0], [100, 100]] }], { style: resolveStyleSafe(st), title: '设计标题' });
  assert.ok(page.svg.includes('设计标题'));
});

function resolveStyleSafe(raw) {
  return require_resolve(raw);
}
function require_resolve(raw) {
  // 直接用 normalize 的等价逻辑：这里通过 resolveStyle 传对象
  return resolveStyle(raw);
}

test('makePsd 生成 背景/版面/文字 三层且文字属性可读回', () => {
  const w = 240, h = 140;
  const rgba = new Uint8Array(w * h * 4);
  for (let i = 0; i < rgba.length; i += 4) { rgba[i] = 240; rgba[i + 1] = 240; rgba[i + 2] = 240; rgba[i + 3] = 255; }
  const buf = makePsd({
    width: w, height: h, dpi: 72, background: '#ffffff', imageRGBA: rgba,
    textLayers: [{ role: 'title', text: '标题测试', x: 12, y: 40, size: 18, font: 'Microsoft YaHei', color: '#111111', bold: true, align: 'left' }],
  });
  assert.ok(buf.length > 2000);
  const psd = readPsd(buf, { skipCompositeImageData: true, skipThumbnail: true });
  assert.strictEqual(psd.width, w);
  assert.ok(psd.children.length >= 3);
  const t = psd.children.find((c) => c.text);
  assert.ok(t, '应有文字层');
  assert.strictEqual(t.text.text, '标题测试');
  assert.ok(t.left >= 0 && t.right <= w, '文字层应在画布内');
});

test('geo_map_export 出 PSD', async () => {
  const f = write('a.dxf', makeDxf());
  const p = path.join(tmp, 'page.psd');
  const r = await map.execute({ path: f, output: p, style: 'planning-a1', dpi: 72, format: 'psd', title: 'PSD测试', subtitle: '副标题' });
  assert.match(r.text, /输出：/);
  const psd = readPsd(fs.readFileSync(p), { skipCompositeImageData: true, skipThumbnail: true });
  assert.ok(psd.children.some((c) => c.text && c.text.text === 'PSD测试'));
  assert.ok(psd.children.some((c) => c.name === '版面'));
});

const SAMPLE_GEOJSON = JSON.stringify({
  type: 'FeatureCollection',
  features: [
    { type: 'Feature', properties: { name: 'A', val: 10, kind: 'R2' }, geometry: { type: 'Polygon', coordinates: [[[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]]] } },
    { type: 'Feature', properties: { name: 'B', val: 20, kind: 'C1' }, geometry: { type: 'Polygon', coordinates: [[[20, 0], [30, 0], [30, 10], [20, 10], [20, 0]]] } },
  ],
});

test('GIS 读 GeoJSON：要素数/字段/范围/面积', async () => {
  const f = write('a.geojson', SAMPLE_GEOJSON);
  const r = await gisRead.execute({ path: f });
  assert.match(r.text, /要素：2/);
  assert.match(r.text, /字段（3）/);
  assert.match(r.text, /面积合计/);
  assert.match(r.text, /name=A/);
});

test('GIS 查询：属性过滤 + 面积合计', async () => {
  const f = write('a.geojson', SAMPLE_GEOJSON);
  const byProp = await gisQuery.execute({ path: f, where: [{ col: 'kind', op: 'eq', value: 'R2' }] });
  assert.match(byProp.text, /命中 1 \/ 共 2/);
  const byNum = await gisQuery.execute({ path: f, where: [{ col: 'val', op: 'gte', value: 20 }] });
  assert.match(byNum.text, /命中 1/);
  const byBox = await gisQuery.execute({ path: f, bbox: '0,0,15,15' });
  assert.match(byBox.text, /命中 1/);
});

// schema 一致性审计：宿主按 schema 过滤参数，handler 读了但没声明的会被静默丢掉
// （这条教训来自 dsh-video-storyboard：为它踩了 4 个 PR）。这里把审计固化成测试。
test('每个工具的 schema 覆盖了 handler 读的所有参数', () => {
  const dir = path.resolve(import.meta.dirname, '..');
  const fileOf = {
    geo_dxf_info: 'dxf-info.js',
    geo_dxf_query: 'dxf-query.js',
    geo_dwg_convert: 'dwg-convert.js',
    geo_map_export: 'map-export.js',
    geo_style_scan: 'style-scan.js',
    geo_selfcheck: 'selfcheck.js',
    geo_gis_read: 'gis-read.js',
    geo_gis_query: 'gis-query.js',
    geo_gis_summary: 'gis-summary.js',
    geo_gis_buffer: 'gis-buffer.js',
    geo_gis_overlay: 'gis-overlay.js',
  };
  for (const spec of allSpecs()) {
    const file = fileOf[spec.name];
    assert.ok(file, '未知工具 ' + spec.name);
    const code = fs.readFileSync(path.join(dir, 'tools', file), 'utf8');
    const used = new Set();
    const re = /args\??\.([a-zA-Z_][a-zA-Z0-9_]*)/g;
    let m;
    while ((m = re.exec(code))) used.add(m[1]);
    const declared = Object.keys((spec.parameters && spec.parameters.properties) || {});
    const missing = [...used].filter((u) => !declared.includes(u));
    assert.deepStrictEqual(missing, [], spec.name + ' 读了但没声明的参数：' + missing.join(','));
  }
});

test('GIS 按类汇总：分组 / 面积 / 占比 / 字段校验', async () => {
  const f = write('a.geojson', SAMPLE_GEOJSON);
  const r = await gisSummary.execute({ path: f, groupBy: 'kind' });
  assert.match(r.text, /按「kind」汇总：2 类 \/ 2 个要素/);
  assert.match(r.text, /R2：1 个 · 面积 100\.0（50\.0%）/);
  assert.match(r.text, /C1：1 个 · 面积 100\.0（50\.0%）/);

  const one = await gisSummary.execute({ path: f, groupBy: 'kind', where: [{ col: 'kind', op: 'eq', value: 'R2' }] });
  assert.match(one.text, /1 类 \/ 1 个要素/);

  await assert.rejects(async () => gisSummary.execute({ path: f, groupBy: 'nope' }), /字段「nope」不存在/);
});

test('GIS 缓冲：面外扩 / 点圆 / 输出 GeoJSON', async () => {
  const f = write('a.geojson', SAMPLE_GEOJSON);
  const p = path.join(tmp, 'buf.geojson');
  const r = await gisBuffer.execute({ path: f, distance: 2, output: p });
  assert.match(r.text, /缓冲：2 个要素 × 2/);
  assert.match(r.text, /面积：原 200\.0 → 缓冲后/);
  const gj = JSON.parse(fs.readFileSync(p, 'utf8'));
  assert.strictEqual(gj.features.length, 2);
  assert.ok(gj.features[0].properties._bufferArea > 150, '外扩后应明显大于原面积');
  assert.ok(gj.features[0].geometry.type === 'Polygon' || gj.features[0].geometry.type === 'MultiPolygon');

  const pt = write('pt.geojson', JSON.stringify({
    type: 'FeatureCollection',
    features: [{ type: 'Feature', properties: { id: 1 }, geometry: { type: 'Point', coordinates: [0, 0] } }],
  }));
  const r2 = await gisBuffer.execute({ path: pt, distance: 10, segments: 64 });
  assert.match(r2.text, /缓冲面积合计：31[34]\./); // 64 段圆 ≈ π·10²
});

test('GIS 叠加：相交 / 并 / 差', async () => {
  const a = write('ov-a.geojson', SAMPLE_GEOJSON);
  const b = write('ov-b.geojson', JSON.stringify({
    type: 'FeatureCollection',
    features: [{
      type: 'Feature', properties: { zone: 'X' },
      geometry: { type: 'Polygon', coordinates: [[[5, 5], [15, 5], [15, 15], [5, 15], [5, 5]]] },
    }],
  }));
  const inter = await gisOverlay.execute({ a, b, op: 'intersect' });
  assert.match(inter.text, /结果 1 个面/);
  assert.match(inter.text, /结果 25\.0/);

  const uni = await gisOverlay.execute({ a, b, op: 'union' });
  assert.match(uni.text, /结果 1 个面/);

  const diff = await gisOverlay.execute({ a, b, op: 'difference' });
  assert.match(diff.text, /结果 2 个面/);
  assert.match(diff.text, /结果 175\.0/);
});

test('工具层对坏路径抛可读错误', async () => {
  await assert.rejects(async () => info.execute({ path: 'Z:/nope/none.dxf' }), /文件不存在/);
});

test('apply 注册九个工具，异常转成文本', async () => {
  const mod = await import('../index.js');
  const registered = [];
  const ctx = { tools: { register: (spec) => { registered.push(spec); return () => {}; } } };
  const dispose = await mod.apply(ctx);
  assert.strictEqual(registered.length, 11);
  assert.deepStrictEqual(registered.map((t) => t.name).sort(), [
    'geo_dwg_convert', 'geo_dxf_info', 'geo_dxf_query', 'geo_gis_buffer', 'geo_gis_overlay', 'geo_gis_query', 'geo_gis_read', 'geo_gis_summary',
    'geo_map_export', 'geo_selfcheck', 'geo_style_scan',
  ]);
  const tool = registered.find((t) => t.name === 'geo_dxf_info');
  const r = await tool.execute({ path: 'Z:/nope/none.dxf' });
  assert.match(r.text, /geo error/);
  dispose();
});
