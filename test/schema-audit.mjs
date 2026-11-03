import fs from 'node:fs';
import path from 'node:path';
import { allSpecs } from '../tool-spec.js';

const dir = path.resolve(import.meta.dirname, '..');
const fileOf = {
  geo_dxf_info: 'dxf-info.js',
  geo_dxf_query: 'dxf-query.js',
  geo_dwg_convert: 'dwg-convert.js',
  geo_map_export: 'map-export.js',
  geo_style_scan: 'style-scan.js',
  geo_selfcheck: 'selfcheck.js',
  geo_gis_read: 'gis-read.js',
  geo_gis_query: 'gis-query.js',
};

let problems = 0;
for (const spec of allSpecs()) {
  const file = fileOf[spec.name];
  if (!file) { console.log('⚠ 未知工具', spec.name); continue; }
  const code = fs.readFileSync(path.join(dir, 'tools', file), 'utf8');
  const used = new Set();
  const re = /args\??\.([a-zA-Z_][a-zA-Z0-9_]*)/g;
  let m;
  while ((m = re.exec(code))) used.add(m[1]);
  const declared = Object.keys((spec.parameters && spec.parameters.properties) || {});
  const missing = [...used].filter((u) => !declared.includes(u));
  const extra = declared.filter((d) => !used.has(d));
  if (missing.length) {
    problems++;
    console.log('❌ ' + spec.name + ' 读了但未声明: ' + missing.join(', '));
  } else {
    console.log('✅ ' + spec.name + ' 参数一致（读 ' + used.size + ' / 声明 ' + declared.length + '）' + (extra.length ? ' | 声明未读: ' + extra.join(',') : ''));
  }
}
console.log(problems ? '❌ 有 ' + problems + ' 处问题' : '✅ 全部一致');
