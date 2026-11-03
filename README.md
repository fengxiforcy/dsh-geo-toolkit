# dsh-geo-toolkit

运维部自研 DSH 插件：GIS + CAD 的分析工具。定位是**读图与数据操作**，出图只出分析图。

## 工具

| 工具 | 做什么 | 依赖 |
|---|---|---|
| `geo_dxf_info` | DXF 概览：图层、实体类型分布、块定义、包围盒、单位推断 | 纯 JS |
| `geo_dxf_query` | 按图层 / 类型 / 文字关键字 / 范围找实体 | 纯 JS |
| `geo_dwg_convert` | DWG → DXF（R13–R2018） | dwgdxf（WASM） |
| `geo_map_export` | DXF → **带版式的分析图**（SVG/PNG/JPG/PDF/PSD，A0–A4，72–600dpi） | 纯 JS（resvg 光栅化） |
| `geo_style_scan` | 读 PSD 版式：文字层级 / 区域 / 生成 style 草稿 | ag-psd |
| `geo_gis_read` | 读矢量数据（SHP / GeoJSON / KML）：要素、字段、范围、坐标系、面积/长度合计 | 纯 JS |
| `geo_gis_query` | 属性条件 + 范围矩形筛选要素，返回命中数与面积/长度合计 | 纯 JS |
| `geo_gis_summary` | 按字段分组汇总：每类要素数 / 面积 / 长度 / 占比 | 纯 JS |
| `geo_gis_buffer` | 缓冲：点/线精确（圆角带），面近似外扩；输出 GeoJSON | polygon-clipping（vendor） |
| `geo_gis_overlay` | 图层叠加：intersect / union / difference，输出 GeoJSON 与面积 | polygon-clipping（vendor） |
| `geo_selfcheck` | 自检：依赖 / 解析 / 版式 / 五格式输出 / GIS 读查 + 空间运算 / 错误路径 | — |

## GIS（2026-11-03 补，纯 JS）

插件运行环境里 **spawn 子进程会被沙箱拒绝（EPERM）**，所以 GIS 读取全部自己实现，不调 GDAL：

| 格式 | 支持 | 说明 |
|---|---|---|
| `.shp` + `.dbf` + `.prj` | ✅ | 自研解析：Point / PolyLine / Polygon / MultiPoint；DBF 中文属性走 GBK 探测 |
| `.geojson` / `.json` | ✅ | 标准 GeoJSON，含 MultiPolygon |
| `.kml` | ✅ | 简易解析（Placemark + coordinates） |
| FileGDB | ❌ | 需要 GDAL；要让 GDAL 跑，只能在 DSH 外手工处理 |

能力：要素数、字段清单、范围、坐标系（.prj）、面积（shoelace，外环减内环）、长度、
属性过滤（eq/ne/gt/gte/lt/lte/contains）、范围矩形相交。

**注意单位**：面积是「坐标单位²」。经纬度数据得到的是度²，不是平方米；米制坐标才是平方米。

### 空间运算（2026-11-03 补）

| 能力 | 精度 | 说明 |
|---|---|---|
| 按类汇总 | 精确 | 按字段分组的要素数 / 面积 / 长度 / 占比，支持 where 过滤 |
| 缓冲 | 点、线精确 | 点是圆、线是圆角带；**面是近似外扩**（凸角准、凹角填平，不做内缩） |
| 叠加 | 精确 | intersect / union / difference，只支持面；点线先缓冲 |

算法用 vendored 的 `polygon-clipping`（MIT）做布尔运算。踩坑：圆端帽与矩形共点会让 sweep-line 退化（`Unable to find segment`），圆环起点做了半段角度偏移规避。

组合用法：`buffer` 出 GeoJSON → `overlay` 裁切 → `summary` 汇总面积，三步串起来就是「道路两侧 10 米内、按用地性质统计面积」。

## 重操作隔离（2026-11-02 事故后加，硬约束）

PNG/JPG/PDF/PSD 的光栅化与 PSD 写入**全部跑在 worker 线程**（`workers/map-worker.js`），不在主进程做：

| 护栏 | 值 | 作用 |
|---|---|---|
| worker 复用 | 常驻 | 避免每次新建 worker 让 RSS 线性涨（实测每次 +20MB） |
| 定期重建 | 每 4 个任务 | 把内存压回基线（实测 terminate 能归还约 50MB） |
| 空闲回收 | 60 秒 | 不跑的时候不占内存 |
| 超时强杀 | 180 秒 | 卡死也不会拖住宿主 |
| 主进程水位 | RSS 1500MB | 超了直接拒绝执行 |

实测（地形图，A1）：

| 场景 | 结果 |
|---|---|
| 连续 10 次 PNG（72dpi） | RSS 在 126–186MB 之间波动，**不再线性增长** |
| 300dpi PNG（9933×7019） | 2.6 秒，峰值 635MB（worker 内，任务后释放） |
| 单测全量 | 1.9 秒 |

调试提醒：测试结束要调 `shutdownHeavy()`（单测已在 `after` 钩子里做了），否则进程要等 60 秒空闲回收。

## 边界（立项时定，不要越界）

- ✅ GIS + CAD 操作、分析图
- ❌ 总平深化、效果图（那是设计决策和 3D 渲染，不是数据处理）
- ❌ 不做「通用 DXF 渲染器」——只画几何与文字，够读图就停

## 已知限制

- **单位不信 `$INSUNITS`**：实测两个真实文件都声明毫米、实际是米。`geo_dxf_info` 按图形跨度推断并标注置信度，坐标从不缩放。
- **DWG 只支持 R13–R2018**：更老/更新的版本会失败，回退到「CAD 另存 DXF」。
- **qgis_process 在沙箱内不可用**（QProcess 权限拒绝）；空间运算走 GDAL 命令行的 SQLite/GEOS。
- **大图**：48MB DXF 解析约 0.9 s（7108 实体），展开块后内存会涨一倍；超时设 120 s。
- 文字超过 `maxTexts`（默认 400）会被跳过并在结果里报数，避免文字糊成一团。

## 版式（style）

出图分两层：**内容**（DXF 实体）和**版式**（页面骨架）。版式是一份 JSON，内置在 `styles/` 下，也可以传文件路径或内联对象。

内置 `planning-a1`：参考一份 A1 规划分析图的图式提炼——

- 顶部标题条：左侧项目名（黑体加粗），右侧图号 + 图名；
- 左侧主图区（带细框，内容自动 contain 并居中）；
- 右侧图例栏：指北针（八瓣）、比例尺（按数值比例分段）、图例（自动从图层生成，辅助图层如图框/说明/0 层会被过滤）、说明文字（自动换行，标点不落行首）。

调版式改 JSON 就行，不用动代码：页面（A0–A4/横竖/dpi）、边距、标题字号字体、主图区范围、图例位置与行高、调色板、图层规则（正则 → 填色/描边/线宽）。

### 从 PSD 示例读版式

PSD 有图层和文字属性，比截图准得多：

```
geo_style_scan({ path: "示例.psd", out: "styles/from-psd-x.json" })
```

会输出画布尺寸、文字层级（字号/字体/颜色/位置）、纵向区域分布，并写一份可直接用的版式草稿。

实测一份 9933×21059 的 PSD（121 图层 / 35 文字层，读取 68 ms）：

- 文字层级：358px（设计标题）→ 171px（题目/副标题，11 条）→ 117px（分标题，17 条）→ 75px（正文）→ 54px（说明）
- 标题自动取到「设计标题自拟」，位置 (321,103)

**边界**：草稿是「单主图」适配，只取最大字号当标题、次档当右上图名、中间当主图。这套模板本身是**多图版式**（一页好几张分图），当前引擎不支持，报告里会明确点出来。

### 从截图/PDF 示例模仿版式

1. 拿到示例图（PNG/JPG 直接看；PDF 先转图）；
2. 量出骨架比例：标题条高度、主图区、图例栏宽度、字号相对大小、配色；
3. 复制 `styles/planning-a1.json` 改数值，存成新名字（如 `styles/示例A.json`）；
4. 出图对比，微调。

调用示例：

```
geo_map_export({ path: "a.dxf", style: "planning-a1", title: "...", subtitle: "03-4 ...", format: "png", dpi: 300 })
```

## 实测（2026-11-02）

| 数据 | 结果 |
|---|---|
| 08街区管控图则.dwg（3.22 MB）→ DXF | 16.1 s（首次含 wasm 加载），产出 48.19 MB |
| 48.19 MB DXF 解析 | 读入 36 ms + 解析 796 ms，59 图层 / 7108 实体 / 75 块定义 |
| 同上出 SVG（1600 px，展开块 20541 实体） | 928 ms |
| 栖霞地形0213.dxf（187 KB，90 实体） | 解析 8 ms，出图 12 ms |
| 文字检索「停车」 | 862 ms，命中 3 条 |
| A1 版式 100dpi（48MB 图） | SVG 1.0 s + 光栅化 8.1 s → 3311×2339 PNG 1.05 MB |
| A1 版式 300dpi（48MB 图） | SVG 1.0 s + 光栅化 10.5 s → 9933×7016 PNG 4.68 MB |
| 300dpi JPG / PDF | 12.2 s / 11.4 s |
| PSD 模板读版式（9933×21059，121 图层） | 68 ms |
| PSD 草稿出图（地形图，A1 自定义页） | SVG 14 ms + 光栅化 1.1 s |
| PSD 输出 100dpi A1（地形图，5 层） | 0.6 s 光栅化 → 2.03 MB |
| PSD 输出 300dpi A1（9933×7019） | 2.9 s → 13.50 MB |

### PSD 输出（分层，文字可编辑）

`format: "psd"` 出分层 PSD：

| 图层 | 内容 |
|---|---|
| 背景 | 页面底色 |
| 版面 | 地图 + 图框 + 图例 + 指北针 + 比例尺（栅格） |
| 说明文字 / 副标题 / 标题 | 文字层（可编辑） |

文字层**既带文字属性也带自渲染像素**——ag-psd 不会为文字层重绘位图，只给属性的话 PS 打开会弹警告且该层空白。所以每层用 @napi-rs/canvas 渲染一份像素，打开立即可见；改字时 PS 仍按属性重排。

依赖 `@napi-rs/canvas` 1.1.0（约 15.5 MB 二进制）。**pnpm 装它会 symlink 栈溢出**，本次是手工下 tarball 解到 node_modules 的。

## 踩过的坑（P2 实测，别踩第二遍）

1. **ARC 的包围盒不能按整圆算**——地形图里有两条 ARC，整圆 bbox 6201×6201，实际弧只占 1/3；按整圆算会让主图缩成邮票。`arcExtentPoints()` 按起止角取端点 + 扫过的 90° 极值点。
2. **DWG 转出来的图有垃圾坐标**——08街区图里有 4 条 LWPOLYLINE 带 1e51 / 1e-296 这种值（acadrust 转换产物）。`isSaneEntity()` 以 1e8 为界整条跳过，并在结果里报数。
3. **图纸散件会把 bbox 撑大**——同一张图里有 55 个 INSERT 在 -28M / -44M（旧图块），主图在 447k/3.58M（高斯-克吕格坐标）。`mainCluster()` 按中心点中位数 + 95% 分位距离剔除，出图默认聚焦主图，`focus:false` 可全画。
4. **MTEXT 控制码必须剥**——`\fMicrosoft YaHei|b1|i0|c134|p34;` 这类前缀不剥，图上全是乱码。`cleanDxfText()` 处理字体/字高/颜色/段落/堆叠/换行/%%d 等。
5. **dwgdxf 会丢 \H**——原始 `\H1.45012x;` 转换后变成 `1.45012x;`，清洗函数对行首的「数字x;」有兜底。
6. **SVG 的 Y 轴翻转只有一处公式**——写两处一定错（第一版多平移了一个 height，整张图白）。
7. **fillAuto 的配色不能按出现顺序**——主图渲染和图例生成是两次独立调用，按顺序分配会让「图例里的红」在主图上变绿。改成按图层名排序后取色，两处传同一份图层表。
8. **主图必须 clip**——长文字会画到侧栏上，压住图例（实测 48MB 图里图框层的说明文字越界）。
9. **图例会长到压住说明**——限 8 条 + 说明位置取 `max(固定值, 图例末尾+26)`。
10. **文字层必须自带像素**——ag-psd 不重绘文字位图，只写属性会让 PS 打开是空白层（实测确认）。
11. **插件里不能 spawn 转换器**——沙箱下 execFileSync 报 EPERM，PCN/JPG/PDF 必须纯 JS（resvg + jpeg-js + 自写 PDF）。

## 开发与测试

```bash
# 纯解析 + 出图单测（不需要 DSH）
node test/smoke.test.mjs

# 手测一个文件
node -e "import('./tools/dxf-info.js').then(m=>m.execute({path:'/path/to/a.dxf',includeText:true,explode:true})).then(r=>console.log(r.text))"
```

## 安装（需 CHG）

从 npm 安装（发布后）：`dsh plugin --profile desktop add dsh-geo-toolkit`；或在 profile 的 `package.json` 里加 `file:/path/to/dsh-geo-toolkit`，并在 `dsh.profile.bundles` 追加 `dsh-geo-toolkit`，重启 DSH 生效。
