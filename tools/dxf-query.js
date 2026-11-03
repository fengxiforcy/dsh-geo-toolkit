// tools/dxf-query.js — geo_dxf_query 的 execute。

import fs from 'node:fs';
import { parseDxf } from '../lib/dxf.js';
import { readDxfText, nowMs } from '../lib/io.js';
import { bboxOf, describeEntity, fmt, arcExtentPoints } from '../lib/geo.js';

/** 单个实体的范围（用于 bbox 相交过滤）。 */
function entityBox(e) {
  const pts = [];
  if (e.points) pts.push(...e.points);
  if (e.type === 'ARC' && e.center && Number.isFinite(e.r)) {
    pts.push(...arcExtentPoints(e));
  } else if (e.center && Number.isFinite(e.r)) {
    pts.push([e.center[0] - e.r, e.center[1] - e.r], [e.center[0] + e.r, e.center[1] + e.r]);
  }
  if (e.pos) pts.push(e.pos);
  if (!pts.length) return null;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of pts) {
    if (p[0] < minX) minX = p[0];
    if (p[1] < minY) minY = p[1];
    if (p[0] > maxX) maxX = p[0];
    if (p[1] > maxY) maxY = p[1];
  }
  return { minX, minY, maxX, maxY };
}

function parseRange(s) {
  if (!s) return null;
  const m = String(s).split(',').map(Number);
  if (m.length !== 4 || m.some((n) => !Number.isFinite(n))) throw new Error('bbox 格式应为 "minX,minY,maxX,maxY"');
  return { minX: m[0], minY: m[1], maxX: m[2], maxY: m[3] };
}

function intersects(a, b) {
  if (!a || !b) return true;
  return a.minX <= b.maxX && a.maxX >= b.minX && a.minY <= b.maxY && a.maxY >= b.minY;
}

export async function execute(args) {
  const path = args?.path;
  if (!path) throw new Error('path 不能为空');
  if (!fs.existsSync(path)) throw new Error('文件不存在：' + path);

  const t0 = nowMs();
  const { text } = readDxfText(path);
  const parsed = parseDxf(text);
  const range = parseRange(args.bbox);
  const layer = args.layer;
  const type = args.type ? String(args.type).toUpperCase() : null;
  const kw = args.text ? String(args.text) : null;

  let list = parsed.entities;
  if (layer) list = list.filter((e) => e.layer === layer);
  if (type) list = list.filter((e) => e.type === type);
  if (kw) list = list.filter((e) => (e.type === 'TEXT' || e.type === 'MTEXT') && String(e.text || '').includes(kw));
  if (range) list = list.filter((e) => intersects(entityBox(e), range));

  const limit = Math.max(1, Math.min(200, Number(args.limit) || 50));
  const bbox = bboxOf(list);
  const cond = [layer ? '图层=' + layer : null, type ? '类型=' + type : null, kw ? '文字含「' + kw + '」' : null, range ? '范围过滤' : null].filter(Boolean).join('｜');

  const out = [];
  out.push('查询：' + (cond || '全图') + '｜命中 ' + list.length + ' / 共 ' + parsed.entities.length + '（' + (nowMs() - t0).toFixed(0) + 'ms）');
  if (bbox) out.push('命中范围：X ' + fmt(bbox.minX) + ' → ' + fmt(bbox.maxX) + '｜Y ' + fmt(bbox.minY) + ' → ' + fmt(bbox.maxY));
  if (list.length > limit) out.push('只列前 ' + limit + ' 条：');
  for (const e of list.slice(0, limit)) out.push('  - [' + (e.layer || '0') + '] ' + describeEntity(e));
  return { text: out.join('\n') };
}
