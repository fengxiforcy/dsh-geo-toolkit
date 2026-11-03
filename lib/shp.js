// dsh-geo-toolkit / lib/shp.js
// ESRI Shapefile 解析（.shp 几何 + .dbf 属性 + .prj 坐标系），零依赖纯 JS。
//
// 为什么不调 GDAL（2026-11-03 实测）：插件运行环境里 spawn 子进程会被沙箱拒绝
// （EPERM），所以所有 GIS 读取都自己做。SHP/DBF 格式简单，够用。
//
// 支持的类型：Point(1) / PolyLine(3) / Polygon(5) / MultiPoint(8)
// 以及带 Z/M 的变体（11/13/15/18/21/23/25/28）——Z/M 坐标读出来但只保留 XY。

import fs from 'node:fs';
import { readDbf } from './dbf.js';

const TYPES = {
  0: 'Null', 1: 'Point', 3: 'PolyLine', 5: 'Polygon', 8: 'MultiPoint',
  11: 'PointZ', 13: 'PolyLineZ', 15: 'PolygonZ', 18: 'MultiPointZ',
  21: 'PointM', 23: 'PolyLineM', 25: 'PolygonM', 28: 'MultiPointM',
};

/**
 * 解析 .shp 文件。
 * @param {Buffer} buf
 * @returns {{shapeType:number, shapeName:string, bbox:object, shapes:Array}}
 */
export function parseShp(buf) {
  if (buf.length < 100) throw new Error('SHP 文件太短');
  const fileCode = buf.readInt32BE(0);
  if (fileCode !== 9994) throw new Error('不是 SHP 文件（文件码 ' + fileCode + '）');

  const shapeType = buf.readInt32LE(32);
  const bbox = {
    minX: buf.readDoubleLE(36),
    minY: buf.readDoubleLE(44),
    maxX: buf.readDoubleLE(52),
    maxY: buf.readDoubleLE(60),
  };

  const shapes = [];
  let off = 100;
  while (off + 8 <= buf.length) {
    const contentLen = buf.readInt32BE(off + 4) * 2; // 长度单位是 16-bit word
    const start = off + 8;
    const end = start + contentLen;
    if (end > buf.length) break;
    const shape = parseShape(buf.subarray(start, end));
    if (shape) shapes.push(shape);
    off = end;
  }
  return { shapeType, shapeName: TYPES[shapeType] || ('type' + shapeType), bbox, shapes };
}

function parseShape(c) {
  if (c.length < 4) return null;
  const t = c.readInt32LE(0);
  if (t === 0) return null; // Null shape

  const base = t % 10; // 1/3/5/8 对应 Point/PolyLine/Polygon/MultiPoint
  if (t === 11 || t === 21 || t === 1) {
    return { type: 'Point', points: [[c.readDoubleLE(4), c.readDoubleLE(12)]] };
  }
  if (t === 8 || t === 18 || t === 28) {
    const n = c.readInt32LE(36);
    const pts = [];
    for (let i = 0; i < n; i++) pts.push([c.readDoubleLE(40 + i * 16), c.readDoubleLE(48 + i * 16)]);
    return { type: 'MultiPoint', points: pts };
  }
  if (base === 3 || base === 5) {
    const nParts = c.readInt32LE(36);
    const nPoints = c.readInt32LE(40);
    const parts = [];
    for (let i = 0; i < nParts; i++) parts.push(c.readInt32LE(44 + i * 4));
    const ptsOff = 44 + nParts * 4;
    const pts = [];
    for (let i = 0; i < nPoints; i++) {
      pts.push([c.readDoubleLE(ptsOff + i * 16), c.readDoubleLE(ptsOff + i * 16 + 8)]);
    }
    const rings = [];
    for (let i = 0; i < nParts; i++) {
      const from = parts[i];
      const to = i + 1 < nParts ? parts[i + 1] : nPoints;
      rings.push(pts.slice(from, to));
    }
    return { type: base === 5 ? 'Polygon' : 'PolyLine', rings };
  }
  return { type: 'Unknown' + t };
}

/**
 * 读一个 shapefile 数据集（同名 .shp/.dbf/.prj）。
 * @param {string} shpPath
 */
export function readShapefile(shpPath) {
  const buf = fs.readFileSync(shpPath);
  const shp = parseShp(buf);
  const base = shpPath.replace(/\.shp$/i, '');
  let dbf = null;
  try {
    if (fs.existsSync(base + '.dbf')) dbf = readDbf(fs.readFileSync(base + '.dbf'));
  } catch (e) {
    dbf = { error: String(e.message || e) };
  }
  let prj = null;
  try {
    if (fs.existsSync(base + '.prj')) prj = fs.readFileSync(base + '.prj', 'utf8').trim();
  } catch { /* ignore */ }

  const features = shp.shapes.map((s, i) => ({
    index: i,
    geometry: s,
    properties: dbf && dbf.records[i] ? dbf.records[i] : {},
  }));

  return {
    format: 'Shapefile',
    shapeType: shp.shapeType,
    shapeName: shp.shapeName,
    bbox: shp.bbox,
    fields: dbf && dbf.fields ? dbf.fields : [],
    crs: prj,
    features,
  };
}
