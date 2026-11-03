// dsh-geo-toolkit / lib/dbf.js
// dBASE .dbf 解析（shapefile 的属性表），零依赖。
// 中文属性常见 GBK 编码，先按 UTF-8 试，乱码再按 GBK 解。

/**
 * @param {Buffer} buf
 * @returns {{records:object[], fields:Array}}
 */
export function readDbf(buf) {
  if (buf.length < 32) throw new Error('DBF 文件太短');
  const numRecords = buf.readUInt32LE(4);
  const headerLen = buf.readUInt16LE(8);
  const recordLen = buf.readUInt16LE(10);

  const fields = [];
  for (let off = 32; off + 32 <= headerLen - 1; off += 32) {
    const rawName = buf.subarray(off, off + 11);
    const name = rawName.toString('latin1').replace(/\0.*$/, '').trim();
    const type = String.fromCharCode(buf[off + 11]);
    const len = buf[off + 16];
    const dec = buf[off + 17];
    if (!name) break;
    fields.push({ name, type, len, dec });
  }

  const records = [];
  for (let r = 0; r < numRecords; r++) {
    const recOff = headerLen + r * recordLen;
    if (recOff + recordLen > buf.length) break;
    if (buf[recOff] === 0x2a) { records.push({}); continue; } // 删除标记
    let p = recOff + 1;
    const rec = {};
    for (const f of fields) {
      const raw = buf.subarray(p, p + f.len);
      p += f.len;
      rec[f.name] = decodeField(raw, f);
    }
    records.push(rec);
  }
  return { records, fields };
}

function decodeField(raw, f) {
  const s = raw.toString('latin1').replace(/\0/g, '').trim();
  if (f.type === 'N' || f.type === 'F') {
    const n = Number(s);
    return Number.isFinite(n) ? n : null;
  }
  if (f.type === 'L') return s === 'T' || s === 'Y' || s === 't' || s === 'y';
  if (f.type === 'D') return s; // YYYYMMDD
  // 字符型：尝试 GBK（中文属性常见）
  const bytes = raw.subarray(0, raw.length);
  try {
    const gbk = new TextDecoder('gbk').decode(bytes).replace(/\0/g, '').trim();
    // 如果 GBK 解码得到正常中文，优先用它
    if (/[\u4e00-\u9fa5]/.test(gbk)) return gbk;
  } catch { /* ignore */ }
  return s;
}
