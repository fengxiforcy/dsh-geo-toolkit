// dsh-geo-toolkit / lib/dwg.js
// DWG -> DXF：dwgdxf（acadrust 编译的 WASM，MIT，零运行时依赖，支持 R13–R2018）。
// init() 只做一次（加载 wasm 约几百 ms），之后复用。

let modPromise = null;
let initPromise = null;

async function load() {
  if (!modPromise) modPromise = import('dwgdxf');
  return modPromise;
}

/**
 * 把 DWG 字节转成 DXF 字节。
 * @param {Uint8Array} bytes
 * @returns {Promise<Buffer>}
 */
export async function dwgToDxf(bytes) {
  const mod = await load();
  if (!initPromise) initPromise = mod.init();
  await initPromise;
  const out = await mod.convertDwgToDxf(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes));
  return Buffer.from(out);
}

/** 是否已加载过（诊断用）。 */
export function dwgReady() {
  return Boolean(initPromise);
}
