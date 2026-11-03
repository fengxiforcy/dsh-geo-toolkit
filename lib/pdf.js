// dsh-geo-toolkit / lib/pdf.js
// 极简 PDF 生成：把渲染好的 RGB 像素作为图像 XObject 放进一页 PDF。
// 不依赖外部程序（沙箱里 spawn 会被拒），矢量内容已在 SVG 里，这里只保证「能交付一个可打印的 PDF」。
// 300dpi 下 A1 的像素密度足够印刷级分析图使用。

import zlib from 'node:zlib';

/**
 * @param {object} opts { widthPx, heightPx, rgb: Buffer, mmW, mmH, title }
 * @returns {Buffer}
 */
export function makePdf({ widthPx, heightPx, rgb, mmW, mmH, title }) {
  const pageW = mmW / 25.4 * 72;
  const pageH = mmH / 25.4 * 72;
  const img = zlib.deflateSync(rgb, { level: 6 });

  const enc = (s) => Buffer.from(s, 'latin1');
  const titleEsc = String(title || 'analysis map').replace(/[()\\]/g, ' ').slice(0, 120);

  const objs = [];
  // 1 catalog
  objs.push(enc('<< /Type /Catalog /Pages 2 0 R >>'));
  // 2 pages
  objs.push(enc('<< /Type /Pages /Kids [3 0 R] /Count 1 >>'));
  // 3 page
  objs.push(enc('<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ' + pageW.toFixed(2) + ' ' + pageH.toFixed(2) + '] /Resources << /XObject << /Im0 4 0 R >> >> /Contents 5 0 R >>'));
  // 4 image xobject
  objs.push(enc('<< /Type /XObject /Subtype /Image /Width ' + widthPx + ' /Height ' + heightPx
    + ' /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode /Length ' + img.length + ' >>\nstream\n'));
  // 5 content
  const content = 'q\n' + pageW.toFixed(2) + ' 0 0 ' + pageH.toFixed(2) + ' 0 0 cm\n/Im0 Do\nQ\n';
  objs.push(enc('<< /Length ' + Buffer.byteLength(content) + ' >>\nstream\n' + content + 'endstream'));
  // 6 info
  objs.push(enc('<< /Title (' + titleEsc + ') /Producer (dsh-geo-toolkit) >>'));

  const chunks = [];
  let offset = 0;
  const push = (buf) => { chunks.push(buf); offset += buf.length; };
  const offsets = [];

  push(enc('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n'));
  objs.forEach((body, i) => {
    const num = i + 1;
    offsets[num] = offset;
    if (num === 4) {
      // image object：header + 二进制流 + endstream
      const head = enc(num + ' 0 obj\n');
      push(head);
      push(body);
      push(img);
      push(enc('\nendstream\nendobj\n'));
    } else if (num === 5) {
      push(enc(num + ' 0 obj\n'));
      push(body);
      push(enc('\nendobj\n'));
    } else {
      push(enc(num + ' 0 obj\n'));
      push(body);
      push(enc('\nendobj\n'));
    }
  });

  const xrefStart = offset;
  let xref = 'xref\n0 ' + (objs.length + 1) + '\n0000000000 65535 f \n';
  for (let i = 1; i <= objs.length; i++) {
    xref += String(offsets[i]).padStart(10, '0') + ' 00000 n \n';
  }
  push(enc(xref));
  push(enc('trailer\n<< /Size ' + (objs.length + 1) + ' /Root 1 0 R /Info 6 0 R >>\nstartxref\n' + xrefStart + '\n%%EOF\n'));
  return Buffer.concat(chunks);
}
