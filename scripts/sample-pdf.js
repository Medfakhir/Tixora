'use strict';
/**
 * Builds a small, valid PDF that looks like an entrance ticket and is clearly
 * marked SAMPLE. Used by the demo and the tests (real tickets come from you).
 */
const crypto = require('crypto');

function esc(s) {
  return String(s).replace(/[^\x20-\x7e]/g, '-').replace(/([\\()])/g, '\\$1');
}

function fakeQr(seed, x0, y0, size) {
  const n = 25;
  const cell = size / n;
  const bits = crypto.createHash('sha512').update(String(seed)).digest();
  const ops = ['0.11 0.09 0.07 rg'];
  const finder = (cx, cy) => {
    ops.push(`${x0 + cx * cell} ${y0 + cy * cell} ${7 * cell} ${7 * cell} re f`);
    ops.push('1 1 1 rg', `${x0 + (cx + 1) * cell} ${y0 + (cy + 1) * cell} ${5 * cell} ${5 * cell} re f`, '0.11 0.09 0.07 rg');
    ops.push(`${x0 + (cx + 2) * cell} ${y0 + (cy + 2) * cell} ${3 * cell} ${3 * cell} re f`);
  };
  const inFinder = (i, j) => (i < 8 && j < 8) || (i >= n - 8 && j < 8) || (i < 8 && j >= n - 8);
  let k = 0;
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      if (inFinder(i, j)) continue;
      const bit = (bits[(k >> 3) % bits.length] >> (k & 7)) & 1;
      k++;
      if (bit) ops.push(`${(x0 + i * cell).toFixed(2)} ${(y0 + j * cell).toFixed(2)} ${cell.toFixed(2)} ${cell.toFixed(2)} re f`);
    }
  }
  finder(0, 0);
  finder(n - 7, 0);
  finder(0, n - 7);
  return ops.join('\n');
}

function samplePdf({ venue = 'BAHIA PALACE', city = 'MARRAKECH', type = 'Adult', number = 'A-0001', valid = 'Valid any day' } = {}) {
  const W = 600;
  const H = 260;
  const content = [
    '0.98 0.96 0.92 rg 0 0 600 260 re f',
    '0.09 0.27 0.25 rg 0 0 160 260 re f',
    '0.78 0.61 0.24 rg 160 0 4 260 re f',
    'BT /F2 17 Tf 1 1 1 rg 22 214 Td (' + esc(venue) + ') Tj ET',
    'BT /F1 11 Tf 0.85 0.8 0.7 rg 22 196 Td (' + esc(city) + ') Tj ET',
    'BT /F2 30 Tf 1 1 1 rg 22 120 Td (' + esc(type.toUpperCase()).slice(0, 10) + ') Tj ET',
    'BT /F1 10 Tf 0.85 0.8 0.7 rg 22 100 Td (Admission - 1 person) Tj ET',
    'BT /F1 9 Tf 0.85 0.8 0.7 rg 22 24 Td (No. ' + esc(number) + ') Tj ET',
    'BT /F2 11 Tf 0.71 0.33 0.18 rg 186 222 Td (ENTRANCE TICKET) Tj ET',
    'BT /F2 22 Tf 0.17 0.13 0.09 rg 186 190 Td (' + esc(venue) + ') Tj ET',
    'BT /F1 12 Tf 0.35 0.3 0.25 rg 186 166 Td (' + esc(valid) + ') Tj ET',
    'BT /F1 12 Tf 0.35 0.3 0.25 rg 186 146 Td (Ticket no. ' + esc(number) + ') Tj ET',
    '0.85 0.2 0.15 RG 2 w 186 52 220 34 re S',
    'BT /F2 13 Tf 0.85 0.2 0.15 rg 197 64 Td (SAMPLE - NOT VALID FOR ENTRY) Tj ET',
    fakeQr(number + type + valid, 440, 60, 130),
    'BT /F1 8 Tf 0.45 0.4 0.35 rg 452 44 Td (Demo code - not scannable) Tj ET',
  ].join('\n');

  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${W} ${H}] /Resources << /Font << /F1 4 0 R /F2 5 0 R >> >> /Contents 6 0 R >>`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>',
    `<< /Length ${Buffer.byteLength(content, 'latin1')} >>\nstream\n${content}\nendstream`,
  ];
  let out = '%PDF-1.4\n%\xe2\xe3\xcf\xd3\n';
  const offsets = [];
  objects.forEach((body, i) => {
    offsets.push(Buffer.byteLength(out, 'latin1'));
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = Buffer.byteLength(out, 'latin1');
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const o of offsets) out += `${String(o).padStart(10, '0')} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

module.exports = { samplePdf };
