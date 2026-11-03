// dsh-geo-toolkit / lib/io.js
// 文件读取与编码探测。DXF 在国内出图软件里常是 GBK，按 UTF-8 硬读会把中文图层名读成乱码。

import fs from 'node:fs';

/** 粗判像不像 DXF 文本（R12 起都是组码行，前几百字符必有 SECTION）。 */
function looksLikeDxf(t) {
  return /\bSECTION\b/.test(t.slice(0, 4000)) || /\bENTITIES\b/.test(t.slice(0, 4000));
}

/**
 * 读 DXF 文本：先 UTF-8，不像 DXF 再按 GBK 解一次；都不像就原样返回（交给解析器报空）。
 * @param {string} path
 * @returns {{text:string, encoding:string, bytes:number}}
 */
export function readDxfText(path) {
  const buf = fs.readFileSync(path);
  const utf8 = buf.toString('utf8');
  if (looksLikeDxf(utf8)) return { text: utf8, encoding: 'utf-8', bytes: buf.length };
  try {
    const gbk = new TextDecoder('gbk').decode(buf);
    if (looksLikeDxf(gbk)) return { text: gbk, encoding: 'gbk', bytes: buf.length };
  } catch { /* 运行时没有 GBK 解码器就跳过 */ }
  return { text: utf8, encoding: 'utf-8?', bytes: buf.length };
}

/** 人类可读的字节数。 */
export function humanBytes(n) {
  if (n >= 1048576) return (n / 1048576).toFixed(2) + ' MB';
  if (n >= 1024) return (n / 1024).toFixed(1) + ' KB';
  return n + ' B';
}

/** 解析耗时用。 */
export function nowMs() {
  return Number(process.hrtime.bigint() / 1000n) / 1000;
}
