// dsh-geo-toolkit / lib/dxf.js
// 零依赖 DXF 解析：实体、图层、块。支持 LINE/LWPOLYLINE/POLYLINE/CIRCLE/ARC/TEXT/MTEXT/POINT/SOLID/INSERT
// 设计：流式读组码，状态机切实体；INSERT 只记录引用（展开由调用方决定）

export function* groupPairs(text) {
  let i = 0; const n = text.length;
  while (i < n) {
    let nl = text.indexOf('\n', i);
    if (nl < 0) nl = n;
    const code = text.slice(i, nl).trim();
    const vStart = nl + 1;
    if (vStart >= n) break;
    let nl2 = text.indexOf('\n', vStart);
    if (nl2 < 0) nl2 = n;
    const value = text.slice(vStart, nl2).replace(/\r$/, '');
    const c = Number(code);
    if (!Number.isNaN(c)) yield [c, value];
    i = nl2 + 1;
  }
}

export function parseDxf(text) {
  const layers = [];
  const entities = [];
  const blocks = new Map();
  const stats = { byType: {}, skipped: 0, sections: [], bytes: text.length };

  let section = null;
  let cur = null;
  let block = null;
  let poly = null;
  let polyPts = null;

  const first = (pairs, code) => { for (const [c, v] of pairs) if (c === code) return v; return undefined; };
  const all = (pairs, code) => pairs.filter(([c]) => c === code).map(([, v]) => v);
  const num = (pairs, code, d = 0) => { const v = first(pairs, code); return v === undefined ? d : Number(v); };

  const target = () => (block ? block.entities : entities);

  function pushEntity(type, pairs) {
    const layer = first(pairs, 8) || '0';
    switch (type) {
      case 'LINE':
        target().push({ type, layer, points: [[num(pairs,10), num(pairs,20)], [num(pairs,11), num(pairs,21)]] });
        break;
      case 'LWPOLYLINE': {
        const xs = all(pairs, 10).map(Number), ys = all(pairs, 20).map(Number);
        const pts = xs.map((x, i) => [x, ys[i] ?? 0]);
        if (pts.length >= 2) target().push({ type, layer, points: pts, closed: (num(pairs,70) & 1) === 1 });
        break;
      }
      case 'CIRCLE':
        target().push({ type, layer, center: [num(pairs,10), num(pairs,20)], r: num(pairs,40) });
        break;
      case 'ARC':
        target().push({ type, layer, center: [num(pairs,10), num(pairs,20)], r: num(pairs,40), start: num(pairs,50), end: num(pairs,51) });
        break;
      case 'TEXT': case 'MTEXT':
        target().push({ type, layer, text: (first(pairs,1) || '') + (all(pairs,3).join('') || ''), pos: [num(pairs,10), num(pairs,20)], height: num(pairs,40) });
        break;
      case 'POINT':
        target().push({ type, layer, pos: [num(pairs,10), num(pairs,20)] });
        break;
      case 'SOLID': case 'TRACE':
        target().push({ type: 'SOLID', layer, points: [[num(pairs,10),num(pairs,20)],[num(pairs,11),num(pairs,21)],[num(pairs,12),num(pairs,22)],[num(pairs,13),num(pairs,23)]] });
        break;
      case 'INSERT':
        target().push({ type, layer, name: first(pairs,2), pos: [num(pairs,10), num(pairs,20)], sx: num(pairs,41,1), sy: num(pairs,42,1), rot: num(pairs,50) });
        break;
      default:
        stats.skipped++;
        return;
    }
    stats.byType[type] = (stats.byType[type] || 0) + 1;
  }

  function handle(node) {
    const { type, pairs } = node;
    if (type === 'SECTION') { return; }               // section 名在循环里用 2 组码设置
    if (type === 'ENDSEC') { section = null; return; }
    if (type === 'EOF') { return; }
    if (type === 'LAYER') { layers.push({ name: first(pairs,2) || '0', color: num(pairs,62,7) }); return; }
    if (type === 'BLOCK') {
      block = { name: first(pairs,2) || '', base: [num(pairs,10), num(pairs,20)], entities: [] };
      return;
    }
    if (type === 'ENDBLK') {
      if (block) { blocks.set(block.name, block); block = null; }
      return;
    }
    if (type === 'POLYLINE') {
      poly = { type: 'POLYLINE', layer: first(pairs,8) || '0', closed: (num(pairs,70) & 1) === 1, points: [] };
      polyPts = [];
      return;
    }
    if (type === 'VERTEX') { if (polyPts) polyPts.push([num(pairs,10), num(pairs,20)]); return; }
    if (type === 'SEQEND') {
      if (poly) {
        poly.points = polyPts || [];
        if (poly.points.length >= 2) {
          target().push(poly);
          // POLYLINE 走单独分支，不进 pushEntity —— 统计要在这里补上，否则类型分布漏掉多段线
          stats.byType[poly.type] = (stats.byType[poly.type] || 0) + 1;
        }
      }
      poly = null; polyPts = null; return;
    }
    if (type === 'ATTRIB' || type === 'ATTDEF') return;
    if (section === 'ENTITIES' || block) pushEntity(type, pairs);
    else stats.skipped++;
  }

  for (const [c, v] of groupPairs(text)) {
    if (c === 0) {
      if (cur) handle(cur);
      cur = { type: v, pairs: [] };
    } else if (cur) {
      cur.pairs.push([c, v]);
      if (cur.type === 'SECTION' && c === 2) { section = v; stats.sections.push(v); }
    }
  }
  if (cur) handle(cur);

  return { layers, entities, blocks, stats };
}

/** 展开 INSERT：把块内实体按插入点/缩放/旋转变换后并入输出（递归，最多 3 层） */
export function explodeInserts(parsed, maxDepth = 3) {
  const out = [];
  const { entities, blocks } = parsed;
  const visit = (list, depth, transform) => {
    for (const e of list) {
      if (e.type === 'INSERT') {
        const b = blocks.get(e.name);
        if (!b || depth >= maxDepth) { out.push(e); continue; }
        const t = compose(transform, e);
        visit(b.entities, depth + 1, t);
        continue;
      }
      out.push(transform ? applyTransform(e, transform) : e);
    }
  };
  const compose = (parent, ins) => {
    const [px, py] = ins.pos; const a = (ins.rot || 0) * Math.PI / 180;
    const local = { tx: px, ty: py, sx: ins.sx, sy: ins.sy, rot: a };
    if (!parent) return local;
    const cos = Math.cos(parent.rot), sin = Math.sin(parent.rot);
    const x = parent.tx + cos * px * parent.sx - sin * py * parent.sy;
    const y = parent.ty + sin * px * parent.sx + cos * py * parent.sy;
    return { tx: x, ty: y, sx: parent.sx * ins.sx, sy: parent.sy * ins.sy, rot: parent.rot + a };
  };
  const tx = (p, t) => {
    const cos = Math.cos(t.rot), sin = Math.sin(t.rot);
    const x = p[0] * t.sx, y = p[1] * t.sy;
    return [t.tx + cos * x - sin * y, t.ty + sin * x + cos * y];
  };
  const applyTransform = (e, t) => {
    const q = { ...e };
    if (q.points) q.points = q.points.map(p => tx(p, t));
    if (q.center) q.center = tx(q.center, t);
    if (q.pos) q.pos = tx(q.pos, t);
    return q;
  };
  visit(entities, 0, null);
  return out;
}
