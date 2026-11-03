// tools/gis-read.js — geo_gis_read 的 execute。
// 读矢量数据（SHP / GeoJSON / KML）的概览：要素数、几何类型、字段、范围、坐标系、样本。

import { readVector, featureMeasure } from '../lib/vector.js';

function fmt(n) {
  const abs = Math.abs(n);
  if (abs >= 1e6) return (n / 1e6).toFixed(2) + 'M';
  if (abs >= 1e3) return (n / 1e3).toFixed(1) + 'k';
  if (abs >= 10) return n.toFixed(1);
  return n.toFixed(4);
}

export async function execute(args) {
  const file = args?.path;
  if (!file) throw new Error('path 不能为空');
  const v = readVector(file);
  const limit = Math.max(1, Math.min(50, Number(args.limit) || 5));

  const out = [];
  out.push('矢量数据：' + file);
  out.push('格式：' + v.format + '｜要素：' + v.features.length + '｜几何：' + (v.geometryType || v.shapeName || '-'));
  out.push('字段（' + v.fields.length + '）：' + (v.fields.map((f) => f.name).join('、') || '无'));
  if (v.bbox) {
    out.push('范围：X ' + fmt(v.bbox.minX) + ' → ' + fmt(v.bbox.maxX) + '｜Y ' + fmt(v.bbox.minY) + ' → ' + fmt(v.bbox.maxY));
  }
  if (v.crs) out.push('坐标系：' + String(v.crs).slice(0, 160));

  // 量算汇总：多边形给面积、折线给长度
  const measures = v.features.map(featureMeasure);
  const areaSum = measures.filter((m) => m.kind === 'area').reduce((s, m) => s + m.value, 0);
  const lenSum = measures.filter((m) => m.kind === 'length').reduce((s, m) => s + m.value, 0);
  if (areaSum > 0) out.push('面积合计：' + fmt(areaSum) + '（坐标单位²，经纬度下是度²）');
  if (lenSum > 0) out.push('长度合计：' + fmt(lenSum) + '（坐标单位）');

  out.push('样本（前 ' + Math.min(limit, v.features.length) + '）：');
  for (const f of v.features.slice(0, limit)) {
    const props = Object.entries(f.properties).slice(0, 6).map(([k, val]) => k + '=' + val).join(', ');
    const m = featureMeasure(f);
    const measure = m.kind === 'area' ? '｜面积 ' + fmt(m.value) : (m.kind === 'length' ? '｜长 ' + fmt(m.value) : '');
    out.push('  - [' + f.index + '] ' + (props || '（无属性）') + measure);
  }
  return { text: out.join('\n') };
}
