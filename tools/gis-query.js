// tools/gis-query.js — geo_gis_query 的 execute。
// 按属性条件 + 范围矩形筛选矢量要素，返回命中数与量算合计。

import { readVector, featureMeasure, featurePoints, bboxOfPoints } from '../lib/vector.js';

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

function parseBBox(s) {
  if (!s) return null;
  const m = String(s).split(',').map(Number);
  if (m.length !== 4 || m.some((n) => !Number.isFinite(n))) throw new Error('bbox 格式应为 "minX,minY,maxX,maxY"');
  return { minX: m[0], minY: m[1], maxX: m[2], maxY: m[3] };
}

function intersects(a, b) {
  return a.minX <= b.maxX && a.maxX >= b.minX && a.minY <= b.maxY && a.maxY >= b.minY;
}

export async function execute(args) {
  const file = args?.path;
  if (!file) throw new Error('path 不能为空');
  const v = readVector(file);
  const conds = Array.isArray(args.where) ? args.where : [];
  const range = parseBBox(args.bbox);
  const limit = Math.max(1, Math.min(100, Number(args.limit) || 20));

  let hits = v.features;
  if (conds.length) {
    hits = hits.filter((f) => conds.every((c) => matchOp(f.properties[c.col], c.op || 'eq', c.value)));
  }
  if (range) {
    hits = hits.filter((f) => {
      const bb = bboxOfPoints(featurePoints(f));
      return bb ? intersects(bb, range) : false;
    });
  }

  const measures = hits.map(featureMeasure);
  const areaSum = measures.filter((m) => m.kind === 'area').reduce((s, m) => s + m.value, 0);
  const lenSum = measures.filter((m) => m.kind === 'length').reduce((s, m) => s + m.value, 0);
  const condText = conds.map((c) => c.col + ' ' + (c.op || 'eq') + ' ' + c.value).join(' 且 ') || '全部';

  const out = [];
  out.push('查询：' + condText + (range ? '｜范围 ' + args.bbox : '') + '｜命中 ' + hits.length + ' / 共 ' + v.features.length);
  if (areaSum > 0) out.push('命中面积合计：' + fmt(areaSum) + '（坐标单位²）');
  if (lenSum > 0) out.push('命中长度合计：' + fmt(lenSum));
  out.push('样本：');
  for (const f of hits.slice(0, limit)) {
    const props = Object.entries(f.properties).slice(0, 6).map(([k, val]) => k + '=' + val).join(', ');
    out.push('  - [' + f.index + '] ' + (props || '（无属性）'));
  }
  if (hits.length > limit) out.push('  …另有 ' + (hits.length - limit) + ' 条未列');
  return { text: out.join('\n') };
}
