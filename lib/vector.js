// dsh-geo-toolkit / lib/vector.js
// 统一矢量读取：SHP / GeoJSON / KML（简单 KML）。全部纯 JS，不依赖 GDAL。
//
// 输出统一结构：
// {
//   format, geometryType, fields: [{name,type}], crs, bbox: {minX,minY,maxX,maxY},
//   features: [{ index, properties, geometry: {type, points|rings} }]
// }

import fs from 'node:fs';
import path from 'node:path';
import { readShapefile } from './shp.js';

/** 计算坐标数组的包围盒。 */
export function bboxOfPoints(points) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of points) {
    if (!p || !Number.isFinite(p[0]) || !Number.isFinite(p[1])) continue;
    if (p[0] < minX) minX = p[0];
    if (p[1] < minY) minY = p[1];
    if (p[0] > maxX) maxX = p[0];
    if (p[1] > maxY) maxY = p[1];
  }
  if (minX === Infinity) return null;
  return { minX, minY, maxX, maxY };
}

/** 多边形面积（shoelace，坐标系单位²；外环减内环）。 */
export function ringArea(ring) {
  let s = 0;
  for (let i = 0, n = ring.length; i < n; i++) {
    const a = ring[i];
    const b = ring[(i + 1) % n];
    s += a[0] * b[1] - b[0] * a[1];
  }
  return Math.abs(s) / 2;
}

export function polygonArea(rings) {
  if (!rings || !rings.length) return 0;
  let total = Math.abs(ringArea(rings[0]));
  for (let i = 1; i < rings.length; i++) total -= Math.abs(ringArea(rings[i]));
  return Math.max(0, total);
}

/** 折线长度。 */
export function lineLength(ring) {
  let s = 0;
  for (let i = 1; i < ring.length; i++) {
    s += Math.hypot(ring[i][0] - ring[i - 1][0], ring[i][1] - ring[i - 1][1]);
  }
  return s;
}

/** 读 GeoJSON。 */
function readGeoJson(text) {
  const j = JSON.parse(text);
  const feats = j.type === 'FeatureCollection' ? (j.features || []) : [j];
  const features = feats.map((f, i) => {
    const g = f.geometry || {};
    let geometry;
    if (g.type === 'Point') geometry = { type: 'Point', points: [g.coordinates] };
    else if (g.type === 'MultiPoint') geometry = { type: 'MultiPoint', points: g.coordinates };
    else if (g.type === 'LineString') geometry = { type: 'PolyLine', rings: [g.coordinates] };
    else if (g.type === 'MultiLineString') geometry = { type: 'PolyLine', rings: g.coordinates };
    else if (g.type === 'Polygon') geometry = { type: 'Polygon', rings: g.coordinates };
    else if (g.type === 'MultiPolygon') geometry = { type: 'Polygon', rings: g.coordinates.flat() };
    else geometry = { type: g.type || 'Unknown' };
    return { index: i, properties: f.properties || {}, geometry };
  });
  const allPts = [];
  for (const f of features) {
    if (f.geometry.points) allPts.push(...f.geometry.points);
    if (f.geometry.rings) for (const r of f.geometry.rings) allPts.push(...r);
  }
  return {
    format: 'GeoJSON',
    geometryType: feats[0] && feats[0].geometry ? feats[0].geometry.type : 'Unknown',
    fields: Object.keys((feats[0] && feats[0].properties) || {}).map((name) => ({ name, type: 'Any' })),
    crs: j.crs ? JSON.stringify(j.crs) : null,
    bbox: bboxOfPoints(allPts),
    features,
  };
}

/** 简易 KML 读取（<coordinates> 里的 "x,y,z" 串；不做完整 XML 解析）。 */
function readKml(text) {
  const features = [];
  const placemarkRe = /<Placemark[\s\S]*?<\/Placemark>/gi;
  let m;
  while ((m = placemarkRe.exec(text))) {
    const block = m[0];
    const nameM = /<name>([\s\S]*?)<\/name>/i.exec(block);
    const coordM = /<coordinates>([\s\S]*?)<\/coordinates>/i.exec(block);
    if (!coordM) continue;
    const pts = coordM[1].trim().split(/\s+/).map((s) => {
      const a = s.split(',').map(Number);
      return [a[0], a[1]];
    }).filter((p) => Number.isFinite(p[0]) && Number.isFinite(p[1]));
    if (!pts.length) continue;
    const isPolygon = /<Polygon/i.test(block);
    features.push({
      index: features.length,
      properties: { name: nameM ? nameM[1].trim() : '' },
      geometry: isPolygon ? { type: 'Polygon', rings: [pts] } : { type: 'PolyLine', rings: [pts] },
    });
  }
  const allPts = [];
  for (const f of features) for (const r of f.geometry.rings) allPts.push(...r);
  return {
    format: 'KML',
    geometryType: features[0] ? features[0].geometry.type : 'Unknown',
    fields: [{ name: 'name', type: 'String' }],
    crs: 'WGS84（KML 规范要求）',
    bbox: bboxOfPoints(allPts),
    features,
  };
}

/**
 * 统一入口。
 * @param {string} file
 */
export function readVector(file) {
  if (!fs.existsSync(file)) throw new Error('文件不存在：' + file);
  const ext = path.extname(file).toLowerCase();
  if (ext === '.shp') return { ...readShapefile(file), geometryType: undefined };
  if (ext === '.geojson' || ext === '.json') return readGeoJson(fs.readFileSync(file, 'utf8'));
  if (ext === '.kml') return readKml(fs.readFileSync(file, 'utf8'));
  throw new Error('暂不支持 ' + ext + '（支持 .shp / .geojson / .json / .kml；FileGDB 需要 GDAL，插件内不可用）');
}

/** 要素的坐标点（统一取法）。 */
export function featurePoints(f) {
  const g = f.geometry || {};
  if (g.points) return g.points;
  if (g.rings) { const out = []; for (const r of g.rings) out.push(...r); return out; }
  return [];
}

/** 单要素面积（多边形）或长度（折线）。 */
export function featureMeasure(f) {
  const g = f.geometry || {};
  if (g.type === 'Polygon' && g.rings) return { kind: 'area', value: polygonArea(g.rings) };
  if (g.type === 'PolyLine' && g.rings) return { kind: 'length', value: g.rings.reduce((s, r) => s + lineLength(r), 0) };
  return { kind: 'none', value: 0 };
}
