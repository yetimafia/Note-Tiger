// Draws Note Tiger's pixel-art logo (a roaring tiger head on a teal burst) and writes every copy of it:
// tiger.png (128px, the window/favicon), site/tiger.png, fonts/tiger-256.png (recap books) and launcher/tiger.ico.
// Run: node tools/make-pixel-tiger.mjs
import fs from 'node:fs';
import zlib from 'node:zlib';

const N = 32;
const px = new Uint8Array(N * N);   // material per pixel
const M = { burst: 1, fur: 2, white: 3, dark: 4, eye: 5, pupil: 6, mouth: 7, tongue: 8, nose: 9, inner: 10 };
const set = (x, y, m) => { x = Math.round(x); y = Math.round(y); if (x >= 0 && y >= 0 && x < N && y < N) px[y * N + x] = M[m] ?? m; };
const at = (x, y) => (x < 0 || y < 0 || x >= N || y >= N ? 0 : px[y * N + x]);
const ell = (cx, cy, rx, ry, m) => { for (let y = Math.floor(cy - ry); y <= Math.ceil(cy + ry); y++) for (let x = Math.floor(cx - rx); x <= Math.ceil(cx + rx); x++) if (((x - cx) / (rx + 0.3)) ** 2 + ((y - cy) / (ry + 0.3)) ** 2 <= 1) set(x, y, m); };
const tri = (a, b, c, m) => {
  const side = (p, q, x, y) => (q[0] - p[0]) * (y - p[1]) - (q[1] - p[1]) * (x - p[0]);
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    const s1 = side(a, b, x, y), s2 = side(b, c, x, y), s3 = side(c, a, x, y);
    if ((s1 >= -0.5 && s2 >= -0.5 && s3 >= -0.5) || (s1 <= 0.5 && s2 <= 0.5 && s3 <= 0.5)) set(x, y, m);
  }
};
const line = (x0, y0, x1, y1, m) => { const n = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0)) * 2 + 1; for (let i = 0; i <= n; i++) set(x0 + (x1 - x0) * i / n, y0 + (y1 - y0) * i / n, m); };

// the teal burst behind the head
for (let i = 0; i < 14; i++) {
  const a = (i / 14) * Math.PI * 2, b = a + Math.PI / 14, c = a - Math.PI / 14;
  tri([16 + Math.cos(a) * 15, 17 + Math.sin(a) * 14], [16 + Math.cos(b) * 9, 17 + Math.sin(b) * 9], [16 + Math.cos(c) * 9, 17 + Math.sin(c) * 9], 'burst');
}
ell(16, 17, 11, 10.5, 'burst');
// ears
tri([5, 4], [12, 8], [6, 13], 'fur'); tri([27, 4], [20, 8], [26, 13], 'fur');
tri([7, 7], [10, 9], [7.5, 11], 'inner'); tri([25, 7], [22, 9], [24.5, 11], 'inner');
// head and cheeks
ell(16, 16, 10, 9, 'fur');
ell(9, 21, 4.5, 3.5, 'fur'); ell(23, 21, 4.5, 3.5, 'fur');
ell(12.5, 21.5, 4, 3.5, 'white'); ell(19.5, 21.5, 4, 3.5, 'white');
ell(16, 26, 4.5, 2.5, 'white');
// roaring mouth with fangs and tongue
ell(16, 24, 3.6, 3, 'mouth'); ell(16, 25.5, 2.2, 1.3, 'tongue');
set(14, 22, 'white'); set(14, 23, 'white'); set(18, 22, 'white'); set(18, 23, 'white');
// nose
tri([14, 18.5], [18, 18.5], [16, 20.5], 'nose');
// eyes with angry brows
ell(11.5, 14.5, 2, 1.5, 'eye'); ell(20.5, 14.5, 2, 1.5, 'eye');
set(12, 14.5, 'pupil'); set(12, 15, 'pupil'); set(20, 14.5, 'pupil'); set(20, 15, 'pupil');
line(9, 12, 13.5, 13.5, 'dark'); line(23, 12, 18.5, 13.5, 'dark');
// stripes
line(16, 8, 16, 11, 'dark'); line(13.5, 8.5, 14, 11, 'dark'); line(18.5, 8.5, 18, 11, 'dark');
line(6, 15, 9, 16, 'dark'); line(6.5, 18, 9, 18.5, 'dark'); line(26, 15, 23, 16, 'dark'); line(25.5, 18, 23, 18.5, 'dark');
line(5, 21, 7.5, 21.5, 'dark'); line(27, 21, 24.5, 21.5, 'dark');

// colours: [shadow, base, light]
const hex = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
const mix = (a, b, t) => a.map((v, i) => Math.round(v + (b[i] - v) * t));
const ramp = (h) => { const c = hex(h); return [mix(c, [20, 12, 30], 0.35), c, mix(c, [255, 250, 235], 0.3)]; };
const PAL = { 1: ramp('#3dd6c6'), 2: ramp('#f08a24'), 3: ramp('#f4efe4'), 4: ramp('#1c1418'), 5: ramp('#c8f04a'), 6: ramp('#1c1418'), 7: ramp('#4a1420'), 8: ramp('#e0566a'), 9: ramp('#e07a8a'), 10: ramp('#f4c4a0') };
const flat = new Set([4, 5, 6, 7, 8]);
function render(withBg) {
  const out = new Uint8Array(N * N * 4);
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    const v = at(x, y), i = (y * N + x) * 4;
    let c = null;
    if (v) {
      const rp = PAL[v];
      c = flat.has(v) ? rp[1] : (at(x + 1, y) !== v && !at(x + 1, y)) || !at(x, y + 1) ? rp[0] : !at(x, y - 1) || !at(x - 1, y) ? rp[2] : rp[1];
      if (v === 2 && (at(x, y + 1) === 3 || at(x + 1, y) === 3)) c = rp[0];
    } else if (at(x - 1, y) || at(x + 1, y) || at(x, y - 1) || at(x, y + 1)) c = [16, 10, 14];
    else if (withBg) {
      // dark rounded square behind, like an app icon
      const r = 5, cx = Math.min(Math.max(x, r), N - 1 - r), cy = Math.min(Math.max(y, r), N - 1 - r);
      if (Math.hypot(x - cx, y - cy) <= r + 0.2) c = [30, 26, 23];
    }
    if (c) out.set([c[0], c[1], c[2], 255], i);
  }
  return out;
}
const CRC = new Uint32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc32 = (b) => { let c = 0xffffffff; for (const x of b) c = CRC[(c ^ x) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
const chunk = (t, d) => { const l = Buffer.alloc(4); l.writeUInt32BE(d.length); const td = Buffer.concat([Buffer.from(t), d]); const c = Buffer.alloc(4); c.writeUInt32BE(crc32(td)); return Buffer.concat([l, td, c]); };
function png(rgba, w, h) {
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) Buffer.from(rgba.buffer, y * w * 4, w * 4).copy(raw, y * (w * 4 + 1) + 1);
  const ih = Buffer.alloc(13); ih.writeUInt32BE(w, 0); ih.writeUInt32BE(h, 4); ih[8] = 8; ih[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ih), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
function scale(rgba, k) {
  const W = N * k, out = new Uint8Array(W * W * 4);
  for (let y = 0; y < W; y++) for (let x = 0; x < W; x++) out.set(rgba.subarray(((Math.floor(y / k)) * N + Math.floor(x / k)) * 4, ((Math.floor(y / k)) * N + Math.floor(x / k)) * 4 + 4), (y * W + x) * 4);
  return out;
}
function shrink(rgba, size) { // nearest-neighbour down/up to any size
  const out = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) { const s = (Math.floor(y * N / size) * N + Math.floor(x * N / size)) * 4; out.set(rgba.subarray(s, s + 4), (y * size + x) * 4); }
  return out;
}
const icon = render(true);
const root = new URL('..', import.meta.url);
fs.writeFileSync(new URL('tiger.png', root), png(scale(icon, 4), 128, 128));
fs.writeFileSync(new URL('site/tiger.png', root), png(scale(icon, 4), 128, 128));
fs.writeFileSync(new URL('fonts/tiger-256.png', root), png(scale(icon, 8), 256, 256));
const sizes = [16, 32, 48, 256];
const pngs = sizes.map((s) => png(shrink(icon, s), s, s));
const head = Buffer.alloc(6 + 16 * sizes.length);
head.writeUInt16LE(1, 2); head.writeUInt16LE(sizes.length, 4);
let off = head.length;
sizes.forEach((s, i) => { const e = 6 + i * 16; head[e] = s % 256; head[e + 1] = s % 256; head.writeUInt16LE(1, e + 4); head.writeUInt16LE(32, e + 6); head.writeUInt32LE(pngs[i].length, e + 8); head.writeUInt32LE(off, e + 12); off += pngs[i].length; });
fs.writeFileSync(new URL('launcher/tiger.ico', root), Buffer.concat([head, ...pngs]));
console.log('pixel tiger written');
