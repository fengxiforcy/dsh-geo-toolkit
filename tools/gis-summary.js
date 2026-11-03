// tools/gis-summary.js — geo_gis_summary 的 execute。
// 按属性字段分组，汇总要素数 / 面积 / 长度，给占比与合计。
// 纯 JS，不依赖 GDAL；面积单位随坐标系（投影坐标为米时是 m²）。

import { readVector, featureMeasure } from '../lib/vector.js';

function fmt(n) {
  const abs = Math.abs(n);
  if (abs >= 1e6) return (n / 1e6).toFixed(2) + 'M';
  if (abs >= 1e3) return (n / 1e3).toFixed(1) + 'k';
  if (abs >= 10) return n.toFixed(1);
  return n.toFixed(4);
}

function matchOp(value, op, target) {
  if (op === 'contains') return String(value ?? '').includes(String(target));
  if (op === 'eq') return String(value) === String(target);
  if (op === 'ne') return String(value) !== String(target);
  const a = Number(value);
  const b = Number(target);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return false;
  if (op === 'gt') return a > b;
  if (op === 'gte') return a >= b;
  if (op === 'lt') return a < b;
  if (op === 'lte') return a <= b;
  return false;
}

export async function execute(args) {
  const file = args?.path;
  if (!file) throw new Error('path 不能为空');
  const groupBy = String(args?.groupBy || '').trim();
  if (!groupBy) throw new Error('groupBy 不能为空（按哪个字段分类，如 用地性质 / DLMC）');

  const v = readVector(file);
  const fieldNames = (v.fields || []).map((f) => f.name);
  if (fieldNames.length && !fieldNames.includes(groupBy)) {
    throw new Error('字段「' + groupBy + '」不存在；可用字段：' + fieldNames.slice(0, 15).join(' / '));
  }

  const conds = Array.isArray(args?.where) ? args.where : [];
  const limit = Math.max(1, Math.min(100, Number(args?.limit) || 20));
  let feats = v.features;
  if (conds.length) {
    feats = feats.filter((f) => conds.every((c) => matchOp(f.properties?.[c.col], c.op || 'eq', c.value)));
  }

  const groups = new Map();
  for (const f of feats) {
    const raw = f.properties?.[groupBy];
    const key = raw === undefined || raw === null || String(raw).trim() === '' ? '(空)' : String(raw);
    let g = groups.get(key);
    if (!g) { g = { key, count: 0, area: 0, length: 0 }; groups.set(key, g); }
    g.count += 1;
    const m = featureMeasure(f);
    if (m.kind === 'area') g.area += m.value;
    else if (m.kind === 'length') g.length += m.value;
  }

  const rows = [...groups.values()];
  const totalCount = rows.reduce((s, r) => s + r.count, 0);
  const totalArea = rows.reduce((s, r) => s + r.area, 0);
  const totalLen = rows.reduce((s, r) => s + r.length, 0);
  rows.sort((a, b) => (b.area - a.area) || (b.length - a.length) || (b.count - a.count));

  const condText = conds.map((c) => c.col + ' ' + (c.op || 'eq') + ' ' + c.value).join(' 且 ');
  const out = [];
  out.push('按「' + groupBy + '」汇总' + (condText ? '（筛选：' + condText + '）' : '') +
    '：' + rows.length + ' 类 / ' + totalCount + ' 个要素' +
    (feats.length !== v.features.length ? '（全库 ' + v.features.length + '）' : ''));
  if (totalArea > 0) out.push('面积合计：' + fmt(totalArea) + '（坐标单位²）');
  if (totalLen > 0) out.push('长度合计：' + fmt(totalLen) + '（坐标单位）');
  out.push('分类（按量降序，前 ' + Math.min(limit, rows.length) + '）：');
  for (const r of rows.slice(0, limit)) {
    const parts = [String(r.count) + ' 个'];
    if (r.area > 0) parts.push('面积 ' + fmt(r.area) + (totalArea > 0 ? '（' + (r.area / totalArea * 100).toFixed(1) + '%）' : ''));
    if (r.length > 0) parts.push('长度 ' + fmt(r.length));
    out.push('  - ' + r.key + '：' + parts.join(' · '));
  }
  if (rows.length > limit) out.push('  …另有 ' + (rows.length - limit) + ' 类未列出（调大 limit）');
  return { text: out.join('\n') };
}
