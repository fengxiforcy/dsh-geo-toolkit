/**
 * dsh-geo-toolkit —— GIS/CAD 分析工具（DSH 插件）。
 *
 * 四个工具：
 *   geo_dxf_info     DXF 概览：图层 / 实体 / 块 / 包围盒 / 单位推断
 *   geo_dxf_query    按图层、类型、文字关键字查实体
 *   geo_dwg_convert  DWG → DXF（dwgdxf / WASM，R13–R2018）
 *   geo_map_export   DXF → SVG 分析图（按图层配色）
 *
 * 边界（立项时定死）：只做 GIS + CAD 的数据操作与**分析图**；
 * 不做总平深化、不做效果图。解析走纯 JS（lib/dxf.js），DWG 才用 WASM。
 *
 * 注册方式：不用 defineTool，直接 ctx.tools.register(spec)（与 dsh-soundtry 同路子，
 * 少一层宿主包解析依赖）。execute 一律返回 { text }，异常转成文本返回，不把工具打成红叉。
 */

import { allSpecs } from './tool-spec.js';
import * as info from './tools/dxf-info.js';
import * as query from './tools/dxf-query.js';
import * as dwg from './tools/dwg-convert.js';
import * as map from './tools/map-export.js';
import * as styleScan from './tools/style-scan.js';
import * as selfcheck from './tools/selfcheck.js';
import * as gisRead from './tools/gis-read.js';
import * as gisQuery from './tools/gis-query.js';
import * as gisSummary from './tools/gis-summary.js';
import * as gisBuffer from './tools/gis-buffer.js';
import * as gisOverlay from './tools/gis-overlay.js';

export const name = 'dsh-geo-toolkit';
export const inject = ['tools'];

const HANDLERS = {
  geo_dxf_info: info.execute,
  geo_dxf_query: query.execute,
  geo_dwg_convert: dwg.execute,
  geo_map_export: map.execute,
  geo_style_scan: styleScan.execute,
  geo_selfcheck: selfcheck.execute,
  geo_gis_read: gisRead.execute,
  geo_gis_query: gisQuery.execute,
  geo_gis_summary: gisSummary.execute,
  geo_gis_buffer: gisBuffer.execute,
  geo_gis_overlay: gisOverlay.execute,
};

export async function apply(ctx) {
  const disposers = [];
  for (const spec of allSpecs()) {
    const handler = HANDLERS[spec.name];
    const wrapped = {
      ...spec,
      execute: async (args) => {
        try {
          if (!handler) throw new Error('no handler for ' + spec.name);
          return await handler(args);
        } catch (e) {
          return { text: 'geo error: ' + (e?.message ?? e) };
        }
      },
    };
    try {
      disposers.push(ctx.tools.register(wrapped));
    } catch (e) {
      // 注册失败只影响这一个工具，不能让整棵插件树起不来。
      // 一定要有可见日志：2026-11-03 就是「缺 output 声明」被静默吞掉，查了半天
      const msg = '[geo-toolkit] register ' + spec.name + ' failed: ' + (e?.message ?? e);
      try { ctx?.logger?.error?.(msg); } catch { /* ignore */ }
      console.error(msg);
    }
  }
  return () => {
    for (const dispose of disposers.reverse()) {
      try { dispose?.(); } catch { /* ignore */ }
    }
  };
}
