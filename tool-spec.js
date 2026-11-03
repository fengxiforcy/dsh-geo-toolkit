// dsh-geo-toolkit / tool-spec.js
// 四个工具的契约（schema 与描述）。execute 在各 tools/*.js，注册在 index.js。
//
// 宿主按 schema 过滤参数：handler 读了、schema 没声明的参数会被静默丢掉。
// 加参数时两处一起改（这里 + tools 里的读取处）。

export const INFO_TOOL = 'geo_dxf_info';
export const QUERY_TOOL = 'geo_dxf_query';
export const DWG_TOOL = 'geo_dwg_convert';
export const MAP_TOOL = 'geo_map_export';
export const STYLE_SCAN_TOOL = 'geo_style_scan';
export const SELFCHECK_TOOL = 'geo_selfcheck';
export const GIS_READ_TOOL = 'geo_gis_read';
export const GIS_QUERY_TOOL = 'geo_gis_query';
export const GIS_SUMMARY_TOOL = 'geo_gis_summary';
export const GIS_BUFFER_TOOL = 'geo_gis_buffer';
export const GIS_OVERLAY_TOOL = 'geo_gis_overlay';

const PATH_DESC = 'DXF 文件绝对路径（或相对当前工作目录）。';
const LAYER_DESC = '只看/只画这一个图层（同名匹配，区分大小写）。';

export function infoSpec() {
  return {
    name: INFO_TOOL,
    description: [
      '看一张 DXF 图的底细：图层清单、实体数与类型分布、块定义、包围盒、单位推断。',
      '',
      'When to use: 拿到一个 .dxf 不知道里面有什么；要判断图层/规模/坐标范围；',
      '要确认「这张图是米还是毫米」（单位按图形跨度推断，不信文件里的 $INSUNITS——实测它常撒谎）。',
      '',
      '只读，不画图。要按条件找实体用 geo_dxf_query，要出图用 geo_map_export。',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: PATH_DESC },
        layer: { type: 'string', description: LAYER_DESC },
        explode: { type: 'boolean', description: '展开块引用后再统计（默认 false；大图会慢一倍）。' },
        includeText: { type: 'boolean', description: '额外列出文字样本（默认 false）。' },
        textLimit: { type: 'number', description: '文字样本条数，默认 20，最多 200。' },
      },
      required: ['path'],
    },
    timeoutMs: 120000,
    isConcurrencySafe() { return true; },
  };
}

export function querySpec() {
  return {
    name: QUERY_TOOL,
    description: [
      '在 DXF 里按条件找实体：图层、类型（LINE/TEXT/CIRCLE/…）、文字关键字，三者可叠加。',
      '',
      'Returns: 命中总数、包围盒、前 N 条摘要（图层/类型/位置/文字）。',
      'When to use: 「这图里有没有 XX 标注」「道路层有多少条线」「找所有含「停车」的文字」。',
      '',
      '注意：文字检索只匹配 TEXT/MTEXT 的原始内容，不做模糊联想。',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: PATH_DESC },
        layer: { type: 'string', description: LAYER_DESC },
        type: { type: 'string', description: '实体类型，如 LINE / LWPOLYLINE / TEXT / MTEXT / CIRCLE / ARC / INSERT。' },
        text: { type: 'string', description: '文字关键字（仅对 TEXT/MTEXT 生效，包含匹配）。' },
        limit: { type: 'number', description: '返回条数上限，默认 50，最多 200。' },
        bbox: { type: 'string', description: '可选范围过滤 "minX,minY,maxX,maxY"（只保留与范围相交的实体）。' },
      },
      required: ['path'],
    },
    timeoutMs: 120000,
    isConcurrencySafe() { return true; },
  };
}

export function dwgSpec() {
  return {
    name: DWG_TOOL,
    description: [
      '把 DWG 转成 DXF（纯本地，dwgdxf/WebAssembly，支持 R13–R2018，用户零安装）。',
      '',
      'When to use: 手上只有 .dwg，需要读图层/实体或出分析图。转完用 geo_dxf_info 看内容。',
      '',
      '版本边界：只支持 R13–R2018（AC1012–AC1032）。更老或更新的 DWG 会失败，',
      '此时回退到「在 CAD 里另存为 DXF」——不要反复重试。',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        input: { type: 'string', description: 'DWG 文件路径。' },
        output: { type: 'string', description: '输出 DXF 路径；默认与输入同目录同名 .dxf。' },
        overwrite: { type: 'boolean', description: '输出已存在时是否覆盖（默认 false）。' },
      },
      required: ['input'],
    },
    timeoutMs: 180000,
    isConcurrencySafe() { return false; },
  };
}

export function mapSpec() {
  return {
    name: MAP_TOOL,
    description: [
      '把 DXF 导出成**带版式的分析图**：图框 + 标题条 + 主图 + 侧栏（指北针 / 比例尺 / 图例 / 说明）。',
      '',
      'When to use: 要出一张能直接看的分析图（A1/A3 横版），或要按某个示例图的版式来排。',
      '定位是分析图，不做总平深化、不做效果图。',
      '',
      'style: 内置版式名（默认 planning-a1）或 .json 文件路径或内联对象。',
      'format: svg（矢量，默认）/ png / jpg / pdf。',
      'title/subtitle 填进标题条左右，note 填进侧栏说明。',
      '',
      'Returns: 输出路径、页面尺寸、主图实体数、跳过的文字与剔除的散件。',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: PATH_DESC },
        output: { type: 'string', description: '输出 SVG 路径；默认与输入同目录同名 .svg。' },
        layer: {
          type: 'array',
          items: { type: 'string' },
          description: '只画这些图层（数组）；不传就画全部。',
        },
        explode: { type: 'boolean', description: '展开块引用（默认 true）。' },
        maxTexts: { type: 'number', description: '最多画多少条文字，默认 400（防止文字糊成一团）。' },
        focus: { type: 'boolean', description: '聚焦主图、剔除远离的散件（默认 true；要画全图传 false）。' },
        style: { type: 'string', description: '版式：内置名（planning-a1）/ .json 路径 / 内联对象。' },
        format: { type: 'string', description: '输出格式：svg（默认）/ png / jpg / pdf / psd（分层：背景/版面/标题/副标题/说明，文字层可编辑）。' },
        dpi: { type: 'number', description: '输出分辨率，默认 300（影响 png/jpg/pdf 像素尺寸）。' },
        title: { type: 'string', description: '标题条左侧主标题（项目名）。' },
        subtitle: { type: 'string', description: '标题条右侧图号 + 图名，如「03-4 现状建筑风貌分析图」。' },
        note: { type: 'string', description: '侧栏底部说明文字。' },
      },
      required: ['path'],
    },
    timeoutMs: 120000,
    isConcurrencySafe() { return true; },
  };
}

export function styleScanSpec() {
  return {
    name: STYLE_SCAN_TOOL,
    description: [
      '读一个 PSD 示例的**版式骨架**：画布尺寸、文字层级（字号/字体/颜色/位置）、纵向区域划分；',
      '传 out 还能生成一份可直接给 geo_map_export 用的版式 JSON 草稿。',
      '',
      'When to use: 老板给一张 PSD 排版稿，要「照着这个版式出图」。',
      'PSD 有图层和文字属性，比从截图猜准得多；PNG/JPG 没有图层，读不出这些。',
      '',
      '边界：草稿是「单主图」适配（最大字号当标题、次档当右上图名、中间当主图）；',
      '一页多张分图的版式，当前引擎不支持，报告里会点出来。',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'PSD 文件路径。' },
        out: { type: 'string', description: '可选：版式 JSON 输出路径（.json）。' },
        name: { type: 'string', description: '可选：版式名。' },
      },
      required: ['path'],
    },
    timeoutMs: 120000,
    isConcurrencySafe() { return true; },
  };
}

export function selfcheckSpec() {
  return {
    name: SELFCHECK_TOOL,
    description: [
      '插件自检：依赖 → DXF 解析 → 版式 → SVG/PNG/JPG/PDF/PSD 五种输出 → 错误路径，一次跑完给 ✅/❌ 清单。',
      '',
      'When to use: 每次改完插件、或怀疑哪一步坏了，先跑它。不需要准备任何文件（自带样例、临时目录、跑完即删）。',
      'full: true 会额外测 48MB 大图解析（慢几秒）。',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        full: { type: 'boolean', description: '额外跑大文件解析（默认 false）。' },
      },
    },
    timeoutMs: 120000,
    isConcurrencySafe() { return true; },
  };
}

export function gisReadSpec() {
  return {
    name: GIS_READ_TOOL,
    description: [
      '读矢量数据（SHP / GeoJSON / KML）的概览：要素数、几何类型、字段、范围、坐标系、样本。',
      '',
      'When to use: 拿到一个 .shp / .geojson 想知道里面有什么；要确认字段名再查询。',
      '纯 JS 解析，不依赖 GDAL；FileGDB 读不了（需要 GDAL，插件内不可用）。',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '矢量文件路径（.shp / .geojson / .json / .kml）。' },
        limit: { type: 'number', description: '样本条数，默认 5，最多 50。' },
      },
      required: ['path'],
    },
    timeoutMs: 60000,
    isConcurrencySafe() { return true; },
  };
}

export function gisQuerySpec() {
  return {
    name: GIS_QUERY_TOOL,
    description: [
      '按属性条件 + 范围矩形筛选矢量要素，返回命中数与面积/长度合计。',
      '',
      'When to use: 「把用地性质是 R2 的挑出来」「算这个范围里的建筑面积」「哪几块在红线内」。',
      'where 是 AND 关系，支持 eq/ne/gt/gte/lt/lte/contains。',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '矢量文件路径。' },
        where: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              col: { type: 'string', description: '字段名' },
              op: { type: 'string', description: 'eq / ne / gt / gte / lt / lte / contains' },
              value: { type: 'string', description: '比较值' },
            },
            required: ['col', 'value'],
          },
          description: '属性条件（AND）。',
        },
        bbox: { type: 'string', description: '范围过滤 "minX,minY,maxX,maxY"。' },
        limit: { type: 'number', description: '样本条数，默认 20。' },
      },
      required: ['path'],
    },
    timeoutMs: 60000,
    isConcurrencySafe() { return true; },
  };
}


export function gisSummarySpec() {
  return {
    name: GIS_SUMMARY_TOOL,
    description: [
      '按属性字段分组汇总矢量要素：每类的要素数、面积、长度与占比，附合计。',
      '',
      'When to use: 「各地类面积各多少」「按用地性质汇总」「哪个村的地最多」「R2 占比多少」。',
      '面积单位随坐标系：投影坐标（米）为 m²；经纬度为度²（无实际意义，需先投影）。',
      '要按范围裁切后再汇总，先用 geo_gis_overlay 裁切，再对本工具传结果文件。',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '矢量文件路径（.shp / .geojson / .json / .kml）。' },
        groupBy: { type: 'string', description: '分类字段名（如 用地性质 / DLMC / name）。' },
        where: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              col: { type: 'string', description: '字段名' },
              op: { type: 'string', description: 'eq / ne / gt / gte / lt / lte / contains' },
              value: { type: 'string', description: '比较值' },
            },
            required: ['col', 'value'],
          },
          description: '可选过滤条件（AND），同 geo_gis_query。',
        },
        limit: { type: 'number', description: '返回前 N 类，默认 20，最多 100。' },
      },
      required: ['path', 'groupBy'],
    },
    timeoutMs: 60000,
    isConcurrencySafe() { return true; },
  };
}


export function gisBufferSpec() {
  return {
    name: GIS_BUFFER_TOOL,
    description: [
      '对矢量要素按距离生成缓冲区，输出 GeoJSON 并汇总缓冲前后面积。',
      '',
      'When to use: 「道路两侧 10 米范围」「地块外扩 50 米」「点周边 500 米」。',
      '精度：点是圆、线是圆角带（精确）；面是**近似外扩**（凸角准确、凹角会被填平，不做内缩）。',
      '距离单位 = 坐标单位（投影为米即米）；经纬度坐标请先投影。大图层先用 where 过滤到 500 个以内。',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '矢量文件路径（.shp / .geojson / .json / .kml）。' },
        distance: { type: 'number', description: '缓冲距离，必须 > 0，单位同坐标。' },
        output: { type: 'string', description: '可选：输出 GeoJSON 路径；不传只返回统计。' },
        where: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              col: { type: 'string', description: '字段名' },
              op: { type: 'string', description: 'eq / ne / gt / gte / lt / lte / contains' },
              value: { type: 'string', description: '比较值' },
            },
            required: ['col', 'value'],
          },
          description: '可选过滤条件（AND）。',
        },
        segments: { type: 'number', description: '圆弧分段数，默认 16（4–128）。' },
      },
      required: ['path', 'distance'],
    },
    timeoutMs: 180000,
    isConcurrencySafe() { return true; },
  };
}


export function gisOverlaySpec() {
  return {
    name: GIS_OVERLAY_TOOL,
    description: [
      '两个面图层做叠加分析：intersect（相交）/ union（合并）/ difference（A 减 B），输出 GeoJSON 与面积。',
      '',
      'When to use: 「把地块裁进红线范围」「算两块用地的重叠面积」「扣除河道后的可用地」。',
      '只支持面；点/线先 geo_gis_buffer 成面再做。结果保留 A 的属性（相交另带 bIndex）。',
      '面积单位随坐标系（投影为米即 m²）；坐标系不一致时先统一再叠加。',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        a: { type: 'string', description: 'A 图层路径（被裁切的一方）。' },
        b: { type: 'string', description: 'B 图层路径（裁切/合并的一方）。' },
        op: { type: 'string', description: 'intersect（默认）/ union / difference' },
        output: { type: 'string', description: '可选：输出 GeoJSON 路径。' },
      },
      required: ['a', 'b'],
    },
    timeoutMs: 180000,
    isConcurrencySafe() { return true; },
  };
}

// 宿主硬性要求：每个工具必须声明 output { schema, render, presentationMeta? }。
// 缺了会在 ctx.tools.register 时被拒（报 "must declare output"），而且注册失败是静默的——
// 2026-11-03 排查了半天才定位到。
const TEXT_OUTPUT = {
  schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      text: { type: 'string', description: '结果文本（模型直接读）' },
    },
    // required 必须放 object 级：属性级写法（text: { required: true }）这个版本不认，
    // 会报 unsupported JSON schema
    required: ['text'],
  },
  render(args, value) {
    return [{ type: 'text', text: String((value && value.text) || '') }];
  },
};

/** 给每个 spec 补默认 output（text 型）；已有 output 的保持原样。 */
function withOutput(spec) {
  if (spec.output) return spec;
  return { ...spec, output: TEXT_OUTPUT };
}

export function allSpecs() {
  return [
    infoSpec(), querySpec(), dwgSpec(), mapSpec(), styleScanSpec(), selfcheckSpec(), gisReadSpec(), gisQuerySpec(), gisSummarySpec(), gisBufferSpec(), gisOverlaySpec(),
  ].map(withOutput);
}
