// lib/buffer.js — 纯 JS 缓冲：点 / 线 / 面 → 缓冲多边形（polygon-clipping 做并集）。
//
// 精度说明：
// - 点：圆（segments 段近似），精确；
// - 线：每段矩形 + 每个顶点圆帽，精确（缓冲半径在顶点处为圆角）；
// - 面：面本身 ∪ 边界缓冲，**近似外扩**——凸角准确，凹角会被填平，不做内缩。
// 坐标为投影单位（米）时面积是 m²；经纬度请先投影。

import polygonClipping from '../vendor/node_modules/polygon-clipping/dist/polygon-clipping.esm.js';
import { ringArea } from './vector.js';

const DEFAULT_SEGMENTS = 16;

function circleRing(cx, cy, r, seg) {
  const ring = [];
  for (let i = 0; i < seg; i++) {
    // 半段偏移：避免圆顶点与矩形边共点触发 sweep-line 退化
    const a = ((i + 0.5) / seg) * Math.PI * 2;
    ring.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
  }
  ring.push(ring[0]);
  return [[ring]]; // MultiPolygon（含一个 Polygon）
}

function segmentRect(a, b, d) {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len = Math.hypot(dx, dy);
  if (len < 1e-12) return null;
  const nx = (-dy / len) * d;
  const ny = (dx / len) * d;
  return [[
    [
      [a[0] + nx, a[1] + ny],
      [b[0] + nx, b[1] + ny],
      [b[0] - nx, b[1] - ny],
      [a[0] - nx, a[1] - ny],
      [a[0] + nx, a[1] + ny],
    ],
  ]];
}

/** 统一几何 → polygon-clipping 的 MultiPolygon（仅面）。 */
export function geometryToMultiPolygon(g) {
  if (!g || g.type !== 'Polygon' || !g.rings || !g.rings.length) return null;
  return [g.rings.map((r) => r.map((p) => [p[0], p[1]]))];
}

/**
 * 缓冲一个要素的几何。
 * @returns {Array|null} polygon-clipping MultiPolygon；不支持的几何返回 null
 */
export function bufferGeometry(g, distance, segments) {
  const d = Math.abs(Number(distance));
  if (!(d > 0)) throw new Error('distance 必须大于 0');
  const seg = Math.max(4, Math.min(128, Math.floor(segments || DEFAULT_SEGMENTS)));
  const parts = [];

  if (g.type === 'Point' || g.type === 'MultiPoint') {
    for (const p of g.points || []) parts.push(circleRing(p[0], p[1], d, seg));
  } else if (g.type === 'PolyLine') {
    for (const ring of g.rings || []) {
      for (let i = 1; i < ring.length; i++) {
        const rect = segmentRect(ring[i - 1], ring[i], d);
        if (rect) parts.push(rect);
      }
      for (const p of ring) parts.push(circleRing(p[0], p[1], d, seg));
    }
  } else if (g.type === 'Polygon') {
    const base = geometryToMultiPolygon(g);
    if (base) parts.push(base);
    for (const ring of g.rings || []) {
      for (let i = 1; i < ring.length; i++) {
        const rect = segmentRect(ring[i - 1], ring[i], d);
        if (rect) parts.push(rect);
      }
      for (const p of ring) parts.push(circleRing(p[0], p[1], d, seg));
    }
  } else {
    return null;
  }

  if (!parts.length) return null;
  if (parts.length === 1) return parts[0];
  // 一次性并集；数量大时按 256 一批，避免递归过深
  if (parts.length <= 256) return polygonClipping.union(parts[0], ...parts.slice(1));
  let acc = polygonClipping.union(parts[0], ...parts.slice(1, 256));
  for (let i = 256; i < parts.length; i += 255) {
    acc = polygonClipping.union(acc, ...parts.slice(i, i + 255));
  }
  return acc;
}

/** MultiPolygon 面积（外环减内环）。 */
export function multiPolygonArea(mp) {
  if (!mp || !mp.length) return 0;
  let s = 0;
  for (const poly of mp) {
    for (let i = 0; i < poly.length; i++) {
      const a = Math.abs(ringArea(poly[i]));
      s += i === 0 ? a : -a;
    }
  }
  return Math.max(0, s);
}

/** MultiPolygon → GeoJSON Polygon / MultiPolygon。 */
export function toGeoJsonGeometry(mp) {
  if (!mp || !mp.length) return null;
  return mp.length === 1 ? { type: 'Polygon', coordinates: mp[0] } : { type: 'MultiPolygon', coordinates: mp };
}
