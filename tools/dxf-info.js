// tools/dxf-info.js — geo_dxf_info 的 execute。

import fs from 'node:fs';
import { parseDxf, explodeInserts } from '../lib/dxf.js';
import { readDxfText, humanBytes, nowMs } from '../lib/io.js';
import { bboxOf, inferUnit, layerStats, fmt, short, isSaneEntity, cleanDxfText, mainCluster } from '../lib/geo.js';

export async function execute(args) {
  const path = args?.path;
  if (!path) throw new Error('path 不能为空');
  if (!fs.existsSync(path)) throw new Error('文件不存在：' + path);

  const t0 = nowMs();
  const { text, encoding, bytes } = readDxfText(path);
  const tRead = nowMs();
  const parsed = parseDxf(text);
  const tParse = nowMs();

  let entities = parsed.entities;
  let exploded = 0;
  if (args.explode) {
    entities = explodeInserts(parsed);
    exploded = entities.length;
  }
  if (args.layer) entities = entities.filter((e) => e.layer === args.layer);

  const anomalies = entities.filter((e) => !isSaneEntity(e)).length;
  const bbox = bboxOf(entities);
  const layers = layerStats(entities);
  const span = bbox ? Math.max(bbox.width, bbox.height) : 0;
  const unit = inferUnit(span);
  const typeCount = {};
  for (const e of entities) typeCount[e.type] = (typeCount[e.type] || 0) + 1;
  const typeLine = Object.entries(typeCount).sort((a, b) => b[1] - a[1]).map(([k, v]) => k + ' ' + v).join(' · ') || '无';

  const out = [];
  out.push('文件：' + path);
  out.push('大小：' + humanBytes(bytes) + '｜编码：' + encoding + '｜读入 ' + (tRead - t0).toFixed(0) + 'ms｜解析 ' + (tParse - tRead).toFixed(0) + 'ms');
  out.push('图层：' + (parsed.layers.length || layers.length) + '｜实体：' + parsed.entities.length + (args.explode ? '（展开后 ' + exploded + '）' : '') + '｜块定义：' + parsed.blocks.size);
  out.push('类型：' + typeLine);
  if (bbox) {
    out.push('包围盒：X ' + fmt(bbox.minX) + ' → ' + fmt(bbox.maxX) + '｜Y ' + fmt(bbox.minY) + ' → ' + fmt(bbox.maxY) + '｜跨度 ' + fmt(bbox.width) + ' × ' + fmt(bbox.height));
    out.push('单位推断：' + unit.label + '（' + unit.confidence + '；按图形跨度推断，坐标未缩放）');
    if (anomalies > 0) out.push('⚠ 坐标异常实体：' + anomalies + ' 个（含 1e51/1e-296 这类垃圾值，已从包围盒排除；出图也会跳过）');
    const focus = mainCluster(entities);
    if (focus.dropped.length > 0) {
      const fb = bboxOf(focus.kept);
      if (fb) out.push('主体范围：X ' + fmt(fb.minX) + ' → ' + fmt(fb.maxX) + '｜Y ' + fmt(fb.minY) + ' → ' + fmt(fb.maxY) + '（剔除 ' + focus.dropped.length + ' 个远离实体后；出图默认按此聚焦）');
    }
  } else {
    out.push('包围盒：无几何实体（可能只有文字或空图）');
  }

  const showLayers = layers.slice(0, args.layer ? 1 : 15);
  if (showLayers.length) {
    out.push('图层分布：');
    for (const row of showLayers) {
      const t = Object.entries(row.byType).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([k, v]) => k + ' ' + v).join('/');
      out.push('  - ' + row.layer + '：' + row.count + '（' + t + '）');
    }
    if (!args.layer && layers.length > showLayers.length) out.push('  …另有 ' + (layers.length - showLayers.length) + ' 个图层未列');
  }

  if (args.includeText) {
    const limit = Math.max(1, Math.min(200, Number(args.textLimit) || 20));
    const texts = entities.filter((e) => (e.type === 'TEXT' || e.type === 'MTEXT') && String(e.text || '').trim()).slice(0, limit);
    out.push('文字样本（' + texts.length + '）：');
    for (const t of texts) out.push('  - [' + (t.layer || '0') + '] ' + short(cleanDxfText(t.text), 60));
    if (texts.length === 0) out.push('  （无文字实体）');
  }

  return { text: out.join('\n') };
}
