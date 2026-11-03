// tools/dwg-convert.js — geo_dwg_convert 的 execute。

import fs from 'node:fs';
import path from 'node:path';
import { dwgToDxf } from '../lib/dwg.js';
import { humanBytes, nowMs } from '../lib/io.js';

export async function execute(args) {
  const input = args?.input;
  if (!input) throw new Error('input 不能为空');
  if (!fs.existsSync(input)) throw new Error('文件不存在：' + input);
  if (!/\.dwg$/i.test(input)) throw new Error('输入应为 .dwg 文件：' + input);

  const output = args.output || path.join(path.dirname(input), path.basename(input).replace(/\.dwg$/i, '.dxf'));
  if (fs.existsSync(output) && !args.overwrite) {
    throw new Error('输出已存在：' + output + '（要覆盖请传 overwrite: true）');
  }

  const src = fs.readFileSync(input);
  const t0 = nowMs();
  let buf;
  try {
    buf = await dwgToDxf(new Uint8Array(src));
  } catch (e) {
    throw new Error('DWG 转换失败（dwgdxf 只支持 R13–R2018）：' + (e?.message || e) + '；可在 CAD 里另存为 DXF 再试');
  }
  const dt = nowMs() - t0;
  fs.writeFileSync(output, buf);

  return {
    text: [
      'DWG → DXF 完成',
      '输入：' + input + '（' + humanBytes(src.length) + '）',
      '输出：' + output + '（' + humanBytes(buf.length) + '）',
      '耗时：' + dt.toFixed(0) + ' ms（首次调用含 wasm 加载）',
      '下一步：geo_dxf_info 看图层与实体，或 geo_map_export 直接出图。',
    ].join('\n'),
  };
}
