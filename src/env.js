'use strict';
/**
 * Minimal .env loader (no dependencies). Values already present in the real
 * environment win, so hosting panels can override anything in .env.
 *
 * Supports: KEY=value, export KEY=value, # comments, "double quoted" (with \n escapes,
 * may span lines), 'single quoted' (literal), and inline " # comments" on unquoted values.
 */
const fs = require('fs');

function parse(text) {
  const out = {};
  const lines = String(text).replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').split('\n');
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i].trim();
    if (!line || line.startsWith('#')) continue;
    if (line.startsWith('export ')) line = line.slice(7).trim();
    const eq = line.indexOf('=');
    if (eq < 1) continue;
    const key = line.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    let val = line.slice(eq + 1).trim();

    if (val.startsWith('"')) {
      let buf = val.slice(1);
      // gather following lines until an unescaped closing quote
      while (!/(^|[^\\])(\\\\)*"/.test(buf) && i + 1 < lines.length) {
        buf += '\n' + lines[++i];
      }
      const m = /^((?:[^"\\]|\\.)*)"/s.exec(buf);
      val = (m ? m[1] : buf).replace(/\\([nrt"\\])/g, (_, c) => ({ n: '\n', r: '\r', t: '\t', '"': '"', '\\': '\\' })[c]);
    } else if (val.startsWith("'")) {
      const end = val.indexOf("'", 1);
      val = end > 0 ? val.slice(1, end) : val.slice(1);
    } else {
      const hash = val.search(/\s#/);
      if (hash >= 0) val = val.slice(0, hash);
      val = val.trim();
    }
    out[key] = val;
  }
  return out;
}

function load(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return {};
  }
  const parsed = parse(text);
  for (const [k, v] of Object.entries(parsed)) {
    if (process.env[k] === undefined) process.env[k] = v;
  }
  return parsed;
}

module.exports = { parse, load };
