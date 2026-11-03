// dsh-geo-toolkit / workers/map-worker.js
// 重活执行器：resvg 光栅化 + PSD 写入。跑在独立 worker 线程里，结束即销毁。
//
// 任务：
//   { type: 'raster', svg, width, format: 'png'|'jpg'|'pdf', mmW, mmH, title }
//   { type: 'psd',    svg, width, dpi, background, textLayers }
// 返回：
//   { ok: true, buffer, width, height } 或 { ok: false, error }

import { parentPort } from 'node:worker_threads';
import jpeg from 'jpeg-js';
import { makePdf } from '../lib/pdf.js';
import { makePsd } from '../lib/psd-writer.js';

async function rasterize(job) {
  const { Resvg } = await import('@resvg/resvg-js');
  const resvg = new Resvg(job.svg, {
    fitTo: { mode: 'width', value: job.width },
    font: { loadSystemFonts: true, defaultFontFamily: 'Microsoft YaHei' },
  });
  const rendered = resvg.render();
  const width = rendered.width;
  const height = rendered.height;

  if (job.format === 'png') {
    return { buffer: rendered.asPng(), width, height };
  }
  if (job.format === 'jpg') {
    const out = jpeg.encode({ data: rendered.pixels, width, height }, 92);
    return { buffer: out.data, width, height };
  }
  if (job.format === 'pdf') {
    const rgba = rendered.pixels;
    const rgb = Buffer.alloc(width * height * 3);
    for (let i = 0, j = 0; i < rgba.length; i += 4, j += 3) {
      rgb[j] = rgba[i];
      rgb[j + 1] = rgba[i + 1];
      rgb[j + 2] = rgba[i + 2];
    }
    return {
      buffer: makePdf({ widthPx: width, heightPx: height, rgb, mmW: job.mmW, mmH: job.mmH, title: job.title || 'analysis map' }),
      width,
      height,
    };
  }
  throw new Error('不支持的 raster 格式：' + job.format);
}

async function writePsd(job) {
  // 只渲染一次：PSD 需要 RGBA 像素，asPng 的编码字节不能用
  const { Resvg } = await import('@resvg/resvg-js');
  const resvg = new Resvg(job.svg, {
    fitTo: { mode: 'width', value: job.width },
    font: { loadSystemFonts: true, defaultFontFamily: 'Microsoft YaHei' },
  });
  const rendered = resvg.render();
  const buffer = makePsd({
    width: rendered.width,
    height: rendered.height,
    dpi: job.dpi || 300,
    background: job.background || '#ffffff',
    imageRGBA: rendered.pixels,
    textLayers: job.textLayers || [],
  });
  return { buffer, width: rendered.width, height: rendered.height };
}

parentPort.on('message', async (job) => {
  try {
    let result;
    if (job.type === 'raster') result = await rasterize(job);
    else if (job.type === 'psd') result = await writePsd(job);
    else throw new Error('未知任务类型：' + job.type);
    parentPort.postMessage({ ok: true, buffer: result.buffer, width: result.width, height: result.height });
  } catch (e) {
    parentPort.postMessage({ ok: false, error: String(e && e.message ? e.message : e) });
  }
});
