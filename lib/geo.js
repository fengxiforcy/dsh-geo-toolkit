// dsh-geo-toolkit / lib/geo.js
// 几何与统计：包围盒、单位推断、图层汇总。坐标一律**不缩放、不改写**，
// 单位只做「推断 + 提示」，因为实测两个真实文件的 $INSUNITS 都声明毫米、实际是米。

/** 坐标合理上限：毫米级 100 公里 = 1e8；国家大地坐标（3.5e6 量级）远在其内。 */
export const SANE_LIMIT = 1e8;

/** 单个点是否合理（有限且未超限）。 */
export function isSanePoint(p) {
  return Array.isArray(p) && Number.isFinite(p[0]) && Number.isFinite(p[1])
    && Math.abs(p[0]) <= SANE_LIMIT && Math.abs(p[1]) <= SANE_LIMIT;
}

/** 实体所有几何点是否都合理。DWG 转出来的图偶发 1e51 / 1e-296 这种垃圾坐标，整条跳过。 */
export function isSaneEntity(e) {
  let ok = true;
  eachPoint(e, (p) => { if (!isSanePoint(p)) ok = false; });
  return ok;
}

/** 圆弧的关键点：两端点 + 扫过的 0/90/180/270 极值点（不能拿整圆来算，会把 bbox 撑大）。 */
export function arcExtentPoints(e) {
  const [cx, cy] = e.center;
  const r = e.r;
  let sweep = ((e.end - e.start) % 360 + 360) % 360;
  if (sweep === 0) sweep = 360; // 起止角相同按整圆处理
  const pts = [];
  const at = (deg) => pts.push([cx + r * Math.cos(deg * Math.PI / 180), cy + r * Math.sin(deg * Math.PI / 180)]);
  at(e.start);
  at(e.start + sweep);
  for (let ang = 0; ang < 360; ang += 90) {
    const d = ((ang - e.start) % 360 + 360) % 360;
    if (d <= sweep) at(ang);
  }
  return pts;
}

/** 把实体涉及的点收集起来（点/线/圆心+半径/圆弧/文字位置）。 */
function eachPoint(e, fn) {
  if (e.points) for (const p of e.points) fn(p);
  if (e.type === 'ARC' && e.center && Number.isFinite(e.r)) {
    for (const p of arcExtentPoints(e)) fn(p);
  } else if (e.center && Number.isFinite(e.r)) {
    fn([e.center[0] - e.r, e.center[1] - e.r]);
    fn([e.center[0] + e.r, e.center[1] + e.r]);
  }
  if (e.pos) fn(e.pos);
}

/**
 * 包围盒。没有几何实体时返回 null。
 * @param {Array} entities
 * @returns {{minX:number,minY:number,maxX:number,maxY:number,width:number,height:number}|null}
 */
export function bboxOf(entities) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const take = (p) => {
    if (!isSanePoint(p)) return;
    if (p[0] < minX) minX = p[0];
    if (p[1] < minY) minY = p[1];
    if (p[0] > maxX) maxX = p[0];
    if (p[1] > maxY) maxY = p[1];
  };
  for (const e of entities) eachPoint(e, take);
  if (minX === Infinity) return null;
  return { minX, minY, maxX, maxY, width: maxX - minX, height: maxY - minY };
}

/**
 * 按图形跨度推断单位（只给提示，不改坐标）。
 *
 * 真实数据给的教训：小区总平常见 200–800（米）；同样的图若按毫米存储则是
 * 200000–800000。两者差三个数量级，跨度是最稳的判据。
 */
export function inferUnit(span) {
  if (!Number.isFinite(span) || span <= 0) return { unit: 'unknown', label: '空图或纯文字', confidence: 'low' };
  if (span >= 50000) return { unit: 'mm', label: '毫米（跨度 ' + fmt(span) + '）', confidence: 'high' };
  if (span >= 2000) return { unit: 'unknown', label: '跨度 ' + fmt(span) + '，米/毫米均有可能', confidence: 'low' };
  if (span >= 1) return { unit: 'm', label: '米（跨度 ' + fmt(span) + '）', confidence: 'medium' };
  return { unit: 'small', label: '跨度 ' + fmt(span) + '，疑似毫米级小构件', confidence: 'low' };
}

/**
 * 清洗 DXF 文字里的格式控制码。
 *
 * MTEXT 会把字体/字号/颜色/段落属性直接写进字符串，例如
 *   \fMicrosoft YaHei|b1|i0|c134|p34;扬州明清历史城区详细规划
 *   \pi89.83148;\fMicrosoft YaHei|b0|i0|...;
 * 不剥掉这些，分析图上的字就全是乱码前缀。
 */
export function cleanDxfText(input) {
  let t = String(input ?? '');
  // 带参数的控制码：\X参数; （字体/字高/字宽/颜色/段落/倾斜/字距/对齐）
  t = t.replace(/\\[fFhHwWqQtTaAcCpP][^;]*;/g, '');
  // 堆叠文字 \Sa^b; → a/b
  t = t.replace(/\\S([^;]*);/g, (_, m) => m.replace('^', '/'));
  // 段落换行、不换行空格
  t = t.replace(/\\P/g, ' ').replace(/\\~/g, ' ');
  // 下划线/上划线/删除线的开关
  t = t.replace(/\\[LlOoKk]/g, '');
  // 分组花括号
  t = t.replace(/[{}]/g, '');
  // 特殊符号
  t = t.replace(/%%[dD]/g, '°').replace(/%%[pP]/g, '±').replace(/%%[cC]/g, '⌀');
  // 兜底：dwgdxf 转换时会丢掉 \\H，留下行首的「1.45012x;」这种字高残渣
  t = t.replace(/^\s*\d+(?:\.\d+)?x\s*;/, '');
  return t.replace(/\s+/g, ' ').trim();
}

/** 实体中心点（够用即可：点/线取均值，圆取圆心，文字取插入点）。 */
export function centerOf(e) {
  const pts = [];
  if (e.points) pts.push(...e.points);
  if (e.center) pts.push(e.center);
  if (e.pos) pts.push(e.pos);
  if (!pts.length) return null;
  let sx = 0, sy = 0, n = 0;
  for (const p of pts) {
    if (!isSanePoint(p)) continue;
    sx += p[0]; sy += p[1]; n += 1;
  }
  return n ? [sx / n, sy / n] : null;
}

function median(sorted) {
  if (!sorted.length) return 0;
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * 聚焦主聚类：总平/管控图常把几个散件（旧图块、原点附近的废对象）留在远处，
 * 一出图主图就缩成邮票。做法：按中心点中位数取 95% 分位距离，超过 4 倍的点剔除。
 * 返回 { kept, dropped }，不做任何坐标改写。
 */
export function mainCluster(entities) {
  const centers = entities.map((e) => centerOf(e));
  const valid = centers.filter(Boolean);
  if (valid.length < 10) return { kept: entities, dropped: [] };
  const mx = median(valid.map((c) => c[0]).sort((a, b) => a - b));
  const my = median(valid.map((c) => c[1]).sort((a, b) => a - b));
  const dists = valid.map((c) => Math.hypot(c[0] - mx, c[1] - my)).sort((a, b) => a - b);
  const d95 = dists[Math.min(dists.length - 1, Math.floor(dists.length * 0.95))] || 0;
  if (d95 === 0) return { kept: entities, dropped: [] };
  const thresh = d95 * 4;
  const kept = [];
  const dropped = [];
  entities.forEach((e, i) => {
    const c = centers[i];
    if (!c || Math.hypot(c[0] - mx, c[1] - my) <= thresh) kept.push(e);
    else dropped.push(e);
  });
  return { kept, dropped };
}

/** 数字简写：1234567 → 1.23M。 */
export function fmt(n) {
  const abs = Math.abs(n);
  if (abs >= 1e6) return (n / 1e6).toFixed(2) + 'M';
  if (abs >= 1e3) return (n / 1e3).toFixed(1) + 'k';
  if (abs >= 10) return n.toFixed(0);
  return n.toFixed(2);
}

/** 按图层统计实体数与类型分布。 */
export function layerStats(entities) {
  const map = new Map();
  for (const e of entities) {
    const key = e.layer || '0';
    let row = map.get(key);
    if (!row) { row = { layer: key, count: 0, byType: {} }; map.set(key, row); }
    row.count += 1;
    row.byType[e.type] = (row.byType[e.type] || 0) + 1;
  }
  return [...map.values()].sort((a, b) => b.count - a.count);
}

/** 单个实体的简短描述（查询结果用）。 */
export function describeEntity(e) {
  const at = e.pos || e.center;
  const where = at ? '(' + fmt(at[0]) + ', ' + fmt(at[1]) + ')' : '';
  switch (e.type) {
    case 'TEXT': case 'MTEXT':
      return e.type + ' ' + JSON.stringify(short(cleanDxfText(e.text), 40)) + (e.height ? ' h=' + fmt(e.height) : '') + (where ? ' @' + where : '');
    case 'CIRCLE':
      return 'CIRCLE r=' + fmt(e.r) + (where ? ' @' + where : '');
    case 'ARC':
      return 'ARC r=' + fmt(e.r) + ' ' + fmt(e.start) + '°–' + fmt(e.end) + '°' + (where ? ' @' + where : '');
    case 'LINE': case 'LWPOLYLINE': case 'POLYLINE':
      return e.type + (e.points ? ' ' + e.points.length + ' 点' : '') + (e.closed ? ' 闭合' : '');
    case 'INSERT':
      return 'INSERT ' + (e.name || '?') + (where ? ' @' + where : '');
    case 'POINT':
      return 'POINT' + (where ? ' @' + where : '');
    case 'SOLID':
      return 'SOLID';
    default:
      return e.type;
  }
}

/** 截断长字符串（按码点，不切代理对）。 */
export function short(s, n) {
  const t = String(s ?? '');
  if (t.length <= n) return t;
  let out = '';
  let count = 0;
  for (const ch of t) {
    out += ch;
    if (++count >= n) break;
  }
  return out + '…';
}
