// dsh-geo-toolkit / lib/psd-writer.js
// 把渲染好的页面写成分层 PSD：背景 / 版面（地图与版式装饰）/ 标题 / 副标题 / 说明。
//
// 文字层既带**文字属性**（PS 里能改字、改字号）也带**我们自己渲染的像素**（打开就可见，
// 不依赖 PS 重绘）。ag-psd 官方说明：它不会为文字层重绘位图，所以像素必须由调用方提供，
// 否则 PS 打开会弹警告且该层空白。
//
// 实测（2026-11-02）：ag-psd 34.1.0 + @napi-rs/canvas 1.1.0，文字层中英文渲染正常，
// 文字属性（内容/字号/字体/位置）读回一致。

import { writePsdBuffer, initializeCanvas } from 'ag-psd';

// canvas 走双路径：优先用 profile 里正常安装的 @napi-rs/canvas；
// 装不上时（pnpm 对这个包的符号链接会栈溢出）回退到插件自带的 vendor 副本。
// vendor 随包分发（约 39MB 含 win32 二进制），保证换机器也能直接跑。
let createCanvas;
try {
  ({ createCanvas } = await import('@napi-rs/canvas'));
} catch {
  ({ createCanvas } = await import('../vendor/node_modules/@napi-rs/canvas/index.js'));
}

let canvasReady = false;
function ensure() {
  if (canvasReady) return;
  initializeCanvas(createCanvas);
  canvasReady = true;
}

/** 把 #rrggbb 转成 ag-psd 的 0–255 颜色对象。 */
function parseColor(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || '#000000'));
  if (!m) return { r: 0, g: 0, b: 0 };
  const n = parseInt(m[1], 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

/**
 * 造一个文字层：属性 + 栅格化像素。
 * @param {object} t { role, text, x, y, size, font, color, bold, align, lineHeight }
 * @param {number} pageW
 */
function buildTextLayer(t) {
  const lines = String(t.text || '').split('\n');
  const size = Math.max(4, Math.round(t.size));
  const lineH = Math.round(t.lineHeight || size * 1.35);
  const measure = createCanvas(8, 8).getContext('2d');
  const fontSpec = (weight) => weight + ' ' + size + 'px "' + (t.font || 'Microsoft YaHei') + '", sans-serif';

  // 先量宽
  measure.font = fontSpec(t.bold ? 'bold' : 'normal');
  let maxW = 1;
  for (const line of lines) {
    if (!line) continue;
    const m = measure.measureText(line);
    if (m.width > maxW) maxW = m.width;
  }
  const pad = Math.max(2, Math.round(size * 0.15));
  const w = Math.ceil(maxW + pad * 2);
  const h = Math.ceil(lineH * lines.length + pad * 2);

  const canvas = createCanvas(w, h);
  const ctx = canvas.getContext('2d');
  ctx.font = fontSpec(t.bold ? 'bold' : 'normal');
  ctx.fillStyle = t.color || '#111111';
  ctx.textBaseline = 'alphabetic';
  lines.forEach((line, i) => {
    const y = pad + size * 0.85 + i * lineH;
    if (t.align === 'right') {
      const lw = ctx.measureText(line).width;
      ctx.fillText(line, w - pad - lw, y);
    } else if (t.align === 'center') {
      const lw = ctx.measureText(line).width;
      ctx.fillText(line, (w - lw) / 2, y);
    } else {
      ctx.fillText(line, pad, y);
    }
  });

  // 页面坐标：按对齐方式反推图层左上角（右对齐时 x 是文字右端，不是左端）
  const left = Math.round(
    t.align === 'right' ? t.x - w + pad
      : t.align === 'center' ? t.x - w / 2 + pad
        : t.x - pad,
  );
  const top = Math.round(t.y - size * 0.85 - pad);

  return {
    name: t.role === 'title' ? '标题' : t.role === 'subtitle' ? '副标题' : '说明文字',
    left,
    top,
    canvas,
    text: {
      text: String(t.text || ''),
      transform: [1, 0, 0, 1, Math.round(t.x), Math.round(t.y)],
      style: {
        font: { name: t.font || 'Microsoft YaHei' },
        fontSize: size,
        fauxBold: Boolean(t.bold),
        fillColor: parseColor(t.color),
      },
      paragraphStyle: { justification: t.align === 'right' ? 'right' : t.align === 'center' ? 'center' : 'left' },
    },
  };
}

/**
 * 写分层 PSD。
 * @param {object} o { width, height, dpi, background, imageRGBA, textLayers, title }
 * @returns {Buffer}
 */
export function makePsd(o) {
  ensure();
  const { width, height } = o;
  const layers = [];

  // 背景层
  const bg = createCanvas(width, height);
  const bgx = bg.getContext('2d');
  bgx.fillStyle = o.background || '#ffffff';
  bgx.fillRect(0, 0, width, height);
  layers.push({ name: '背景', canvas: bg });

  // 版面层（地图 + 图框 + 图例 + 指北针 + 比例尺，不含标题文字）
  if (o.imageRGBA) {
    const img = createCanvas(width, height);
    const ctx = img.getContext('2d');
    const id = ctx.createImageData(width, height);
    id.data.set(o.imageRGBA);
    ctx.putImageData(id, 0, 0);
    layers.push({ name: '版面', canvas: img });
  }

  // 文字层（从下到上：说明、副标题、标题）
  const ordered = [...(o.textLayers || [])].sort((a, b) => ['note', 'subtitle', 'title'].indexOf(a.role) - ['note', 'subtitle', 'title'].indexOf(b.role));
  for (const t of ordered) layers.push(buildTextLayer(t));

  const psd = { width, height, children: layers };
  return writePsdBuffer(psd, { canvas: createCanvas });
}
