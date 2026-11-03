// tools/style-scan.js — geo_style_scan 的 execute。
// 读 PSD 的版式骨架；可选写一份能直接给 geo_map_export 用的 style JSON 草稿。

import fs from 'node:fs';
import path from 'node:path';
import { readPsdLayout, textLevels, regions, layoutToStyle, formatPsdReport } from '../lib/psd.js';

export async function execute(args) {
  const file = args?.path;
  if (!file) throw new Error('path 不能为空');
  if (!fs.existsSync(file)) throw new Error('文件不存在：' + file);
  if (!/\.psd$/i.test(file)) throw new Error('目前只支持 .psd（PNG/JPG 没有图层结构，读不出字号与分区）');

  const layout = readPsdLayout(file);
  const levels = textLevels(layout);
  const regionList = regions(layout);
  const lines = [formatPsdReport(layout, levels, regionList)];

  const multi = regionList.filter((r) => r.texts > 6).length;
  if (multi > 1) lines.push('提示：纵向有多个文字密集区（' + multi + ' 个），可能是多图版式；当前引擎是单主图，草稿只保留中间一段。');

  if (args.out) {
    const style = layoutToStyle(layout, { name: args.name || path.basename(file, '.psd'), source: path.basename(file) });
    fs.writeFileSync(args.out, JSON.stringify(style, null, 2), 'utf8');
    lines.push('');
    lines.push('版式草稿已写入：' + args.out);
    lines.push('直接可用：geo_map_export({ path: "xxx.dxf", style: ' + JSON.stringify(args.out.replace(/\\/g, '/')) + ', format: "png" })');
  } else {
    lines.push('');
    lines.push('想要版式 JSON 草稿，再传 out: "/path/to/styles/xxx.json"。');
  }
  return { text: lines.join('\n') };
}
