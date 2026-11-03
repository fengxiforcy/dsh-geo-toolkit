// tools/gis-buffer.js — geo_gis_buffer 的 execute。
// 对点 / 线 / 面按距离生成缓冲，输出 GeoJSON 并汇总面积。

import fs from 'node:fs';
import { readVector, featureMeasure } from '../lib/vector.js';
import { bufferGeometry, multiPolygonArea, toGeoJsonGeometry } from '../lib/buffer.js';

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

const MAX_FEATURES = 500;

export async function execute(args) {
  const file = args?.path;
  if (!file) throw new Error('path 不能为空');
  const distance = Number(args?.distance);
  if (!(distance > 0)) throw new Error('distance 必须大于 0（坐标单位；投影为米时即米）');

  const v = readVector(file);
  const conds = Array.isArray(args?.where) ? args.where : [];
  let feats = v.features;
  if (conds.length) {
    feats = feats.filter((f) => conds.every((c) => matchOp(f.properties?.[c.col], c.op || 'eq', c.value)));
  }
  if (!feats.length) return { text: '没有符合条件的要素（共 ' + v.features.length + '）' };
  if (feats.length > MAX_FEATURES) {
    throw new Error('要素过多（' + feats.length + '），请先用 where 过滤到 ' + MAX_FEATURES + ' 以内再缓冲');
  }

  const features = [];
  let beforeArea = 0;
  let afterArea = 0;
  let skipped = 0;
  for (const f of feats) {
    let g;
    try {
      g = bufferGeometry(f.geometry, distance, args?.segments);
    } catch {
      g = null;
    }
    if (!g || !g.length) { skipped += 1; continue; }
    const area = multiPolygonArea(g);
    afterArea += area;
    const m = featureMeasure(f);
    if (m.kind === 'area') beforeArea += m.value;
    features.push({
      type: 'Feature',
      properties: { ...(f.properties || {}), _srcIndex: f.index, _bufferDistance: distance, _bufferArea: area },
      geometry: toGeoJsonGeometry(g),
    });
  }

  const out = [];
  out.push('缓冲：' + feats.length + ' 个要素 × ' + distance + '（坐标单位）' +
    (skipped ? '｜跳过 ' + skipped + ' 个不支持的几何' : ''));
  if (beforeArea > 0) out.push('面积：原 ' + fmt(beforeArea) + ' → 缓冲后 ' + fmt(afterArea) +
    '（+' + fmt(afterArea - beforeArea) + '，约 ' + ((afterArea / beforeArea - 1) * 100).toFixed(1) + '%）');
  else out.push('缓冲面积合计：' + fmt(afterArea) + '（坐标单位²；点/线无原始面积）');

  if (args?.output && features.length) {
    const gj = { type: 'FeatureCollection', features };
    if (v.crs) gj.crs = v.crs;
    fs.writeFileSync(args.output, JSON.stringify(gj));
    out.push('已写：' + args.output + '（GeoJSON，' + features.length + ' 个要素，可直接 geo_gis_summary 汇总）');
  } else {
    out.push('未指定 output，只返回统计（要落盘传 output 路径）');
  }
  return { text: out.join('\n') };
}
