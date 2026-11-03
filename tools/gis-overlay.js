// tools/gis-overlay.js — geo_gis_overlay 的 execute。
// 两个面图层的叠加：intersect（相交）/ union（合并）/ difference（A 减 B）。
// 用 polygon-clipping 做精确布尔运算；点/线先缓冲再用。

import fs from 'node:fs';
import polygonClipping from '../vendor/node_modules/polygon-clipping/dist/polygon-clipping.esm.js';
import { readVector } from '../lib/vector.js';
import { geometryToMultiPolygon, multiPolygonArea, toGeoJsonGeometry } from '../lib/buffer.js';

function fmt(n) {
  const abs = Math.abs(n);
  if (abs >= 1e6) return (n / 1e6).toFixed(2) + 'M';
  if (abs >= 1e3) return (n / 1e3).toFixed(1) + 'k';
  if (abs >= 10) return n.toFixed(1);
  return n.toFixed(4);
}

const MAX_PAIRS = 20000;
const MAX_UNION_PARTS = 400;

function asMulti(f) {
  const mp = geometryToMultiPolygon(f.geometry);
  return mp ? { f, mp } : null;
}

export async function execute(args) {
  const fileA = args?.a;
  const fileB = args?.b;
  if (!fileA || !fileB) throw new Error('a / b 两个文件路径都要给');
  const op = String(args?.op || 'intersect');
  if (!['intersect', 'union', 'difference'].includes(op)) {
    throw new Error('op 只支持 intersect / union / difference');
  }

  const va = readVector(fileA);
  const vb = readVector(fileB);
  const A = va.features.map(asMulti).filter(Boolean);
  const B = vb.features.map(asMulti).filter(Boolean);
  if (!A.length || !B.length) throw new Error('两侧都要有面要素（点/线请先 geo_gis_buffer）');

  const areaA = A.reduce((s, x) => s + multiPolygonArea(x.mp), 0);
  const areaB = B.reduce((s, x) => s + multiPolygonArea(x.mp), 0);
  const features = [];
  let failed = 0;
  let outArea = 0;

  if (op === 'union') {
    if (A.length + B.length > MAX_UNION_PARTS) {
      throw new Error('要素过多（' + (A.length + B.length) + '），union 请先过滤到 ' + MAX_UNION_PARTS + ' 以内');
    }
    let acc = A[0].mp;
    const all = [...A.slice(1).map((x) => x.mp), ...B.map((x) => x.mp)];
    for (const mp of all) {
      try { acc = polygonClipping.union(acc, mp); } catch { failed += 1; }
    }
    if (acc && acc.length) {
      outArea = multiPolygonArea(acc);
      features.push({
        type: 'Feature',
        properties: { _op: 'union', _area: outArea, _aCount: A.length, _bCount: B.length },
        geometry: toGeoJsonGeometry(acc),
      });
    }
  } else if (op === 'difference') {
    if (A.length * B.length > MAX_PAIRS) {
      throw new Error('要素对过多（' + (A.length * B.length) + '），请先过滤');
    }
    let ball = B[0].mp;
    for (let i = 1; i < B.length; i++) {
      try { ball = polygonClipping.union(ball, B[i].mp); } catch { failed += 1; }
    }
    for (const x of A) {
      try {
        const res = polygonClipping.difference(x.mp, ball);
        if (res && res.length) {
          const area = multiPolygonArea(res);
          outArea += area;
          features.push({
            type: 'Feature',
            properties: { ...(x.f.properties || {}), _aIndex: x.f.index, _op: 'difference', _area: area },
            geometry: toGeoJsonGeometry(res),
          });
        }
      } catch { failed += 1; }
    }
  } else {
    if (A.length * B.length > MAX_PAIRS) {
      throw new Error('要素对过多（' + (A.length * B.length) + '），请先过滤');
    }
    for (const x of A) {
      for (const y of B) {
        try {
          const res = polygonClipping.intersection(x.mp, y.mp);
          if (res && res.length) {
            const area = multiPolygonArea(res);
            if (area <= 0) continue;
            outArea += area;
            features.push({
              type: 'Feature',
              properties: {
                ...(x.f.properties || {}),
                _aIndex: x.f.index,
                _bIndex: y.f.index,
                _op: 'intersect',
                _area: area,
              },
              geometry: toGeoJsonGeometry(res),
            });
          }
        } catch { failed += 1; }
      }
    }
  }

  const out = [];
  out.push('叠加（' + op + '）：A ' + A.length + ' 个面 / B ' + B.length + ' 个面' +
    '｜结果 ' + features.length + ' 个面' + (failed ? '（' + failed + ' 组退化跳过）' : ''));
  out.push('面积：A ' + fmt(areaA) + '｜B ' + fmt(areaB) + '｜结果 ' + fmt(outArea));
  if (op === 'intersect') {
    const ratio = areaA > 0 ? ((outArea / areaA) * 100).toFixed(1) : '—';
    out.push('相交占 A 面积：' + ratio + '%');
  }
  if (op === 'difference') out.push('注：结果为 A - B，属性沿用 A');

  if (args?.output && features.length) {
    const gj = { type: 'FeatureCollection', features };
    fs.writeFileSync(args.output, JSON.stringify(gj));
    out.push('已写：' + args.output + '（GeoJSON）');
  } else if (args?.output) {
    out.push('结果为空，未写文件');
  } else if (features.length) {
    out.push('未指定 output，只看统计（要落盘传 output 路径）');
  }
  return { text: out.join('\n') };
}
