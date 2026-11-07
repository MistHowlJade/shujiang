#!/usr/bin/env node
// 书匠 · 图标生成器（手绘像素，无任何依赖）
// 4× 超采样渲染 → 下采样 → build/icon.png + build/icon.ico（PNG-in-ICO，Win 10/11 认）
// 运行：tools\node\node.exe dev\make-icon.mjs
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BUILD_DIR = path.join(ROOT, 'build');

const SCALE = 4;            // 超采样倍数
const S = 256;              // 输出尺寸
const BIG = S * SCALE;      // 渲染尺寸

// ---------- 小工具 ----------
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const hex = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
const mix = (a, b, t) => [0, 1, 2].map((i) => Math.round(a[i] + (b[i] - a[i]) * t));

function roundedRect(x, y, w, h, r, fill) {
  const d = Math.min(r, w / 2, h / 2);
  const edge = (px, py) => {
    // 圆角矩形外形：返回到边缘的符号距离（负=内，正=外），用于抗锯齿
    const qx = Math.max(Math.abs(px - (x + w / 2)) - (w / 2 - d), 0);
    const qy = Math.max(Math.abs(py - (y + h / 2)) - (h / 2 - d), 0);
    return Math.hypot(qx, qy) - d;
  };
  return { edge, fill };
}
function polygon(points, fill) {
  // 点是否在多边形内（射线法）
  const inside = (px, py) => {
    let c = false;
    for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
      const [xi, yi] = points[i], [xj, yj] = points[j];
      const hit = ((yi > py) !== (yj > py)) && (px < ((xj - xi) * (py - yi)) / (yj - yi) + xi);
      if (hit) c = !c;
    }
    return c;
  };
  return { fill, inside };
}

// ---------- 画布 ----------
const buf = Buffer.alloc(BIG * BIG * 4);
function setPix(x, y, rgb, alpha = 1) {
  if (x < 0 || y < 0 || x >= BIG || y >= BIG) return;
  const i = (y * BIG + x) * 4;
  const a = clamp(alpha, 0, 1);
  buf[i] = Math.round(buf[i] * (1 - a) + rgb[0] * a);
  buf[i + 1] = Math.round(buf[i + 1] * (1 - a) + rgb[1] * a);
  buf[i + 2] = Math.round(buf[i + 2] * (1 - a) + rgb[2] * a);
  buf[i + 3] = Math.round(255 - (255 - buf[i + 3]) * (1 - a));
}
function fillShape(shape, rgb) {
  const isPoly = typeof shape.inside === 'function';
  const step = 1 / 3;   // 3×3 亚像素采样，让边缘更平滑
  for (let y = 0; y < BIG; y++) {
    for (let x = 0; x < BIG; x++) {
      let hits = 0;
      for (let sy = 0; sy < 3; sy++) {
        for (let sx = 0; sx < 3; sx++) {
          const px = x + (sx + 0.5) / 3, py = y + (sy + 0.5) / 3;
          const inside = isPoly ? shape.inside(px, py) : shape.edge(px, py) <= 0;
          if (inside) hits++;
        }
      }
      if (hits) setPix(x, y, rgb, hits / 9);
    }
  }
}
function fillSegment(x1, y1, x2, y2, width, rgb) {
  const dx = x2 - x1, dy = y2 - y1;
  const len2 = dx * dx + dy * dy;
  const r = width / 2;
  const minX = Math.floor(Math.min(x1, x2) - r - 1), maxX = Math.ceil(Math.max(x1, x2) + r + 1);
  const minY = Math.floor(Math.min(y1, y2) - r - 1), maxY = Math.ceil(Math.max(y1, y2) + r + 1);
  for (let y = minY; y <= maxY; y++) {
    for (let x = minX; x <= maxX; x++) {
      let t = len2 === 0 ? 0 : ((x - x1) * dx + (y - y1) * dy) / len2;
      t = clamp(t, 0, 1);
      const dist = Math.hypot(x - (x1 + t * dx), y - (y1 + t * dy));
      const a = clamp(r + 0.5 - dist, 0, 1);
      if (a > 0) setPix(x, y, rgb, a);
    }
  }
}

// ---------- 绘制（坐标按 256 设计，乘以 SCALE） ----------
const N = (v) => v * SCALE;
const NAVY = hex('#1c2733'), CREAM = hex('#f5f0e6'), CREAM_R = hex('#ece4d4'),
      SPINE = hex('#c9bda6'), VERMILION = hex('#e2624b');

fillShape(roundedRect(0, 0, BIG, BIG, N(56)), NAVY);

const leftPage = [
  [N(126), N(110)], [N(99), N(98)], [N(74), N(96)], [N(50), N(104)],
  [N(50), N(176)], [N(75), N(165)], [N(100), N(167)], [N(126), N(182)],
];
const rightPage = [
  [N(130), N(110)], [N(157), N(98)], [N(182), N(96)], [N(206), N(104)],
  [N(206), N(176)], [N(181), N(165)], [N(156), N(167)], [N(130), N(182)],
];
fillShape(polygon(leftPage), CREAM);
fillShape(polygon(rightPage), CREAM_R);
fillSegment(N(128), N(111), N(128), N(181), N(3), SPINE);

const nib = [
  [N(172), N(42)], [N(210), N(112)], [N(194), N(119)], [N(158), N(51)],
];
fillShape(polygon(nib), VERMILION);
fillSegment(N(169), N(74), N(190), N(105), N(4), NAVY);

// ---------- 下采样（box filter） ----------
function downsample(size) {
  const out = Buffer.alloc(size * size * 4);
  const ratio = BIG / size;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0, a = 0, n = 0;
      const x0 = Math.floor(x * ratio), x1 = Math.floor((x + 1) * ratio);
      const y0 = Math.floor(y * ratio), y1 = Math.floor((y + 1) * ratio);
      for (let sy = y0; sy < y1; sy++) {
        for (let sx = x0; sx < x1; sx++) {
          const i = (sy * BIG + sx) * 4;
          r += buf[i]; g += buf[i + 1]; b += buf[i + 2]; a += buf[i + 3]; n++;
        }
      }
      const o = (y * size + x) * 4;
      out[o] = Math.round(r / n); out[o + 1] = Math.round(g / n);
      out[o + 2] = Math.round(b / n); out[o + 3] = Math.round(a / n);
    }
  }
  return out;
}

// ---------- PNG 编码 ----------
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
function encodePng(rgba, size) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr.writeUInt8(8, 8);   // 位深
  ihdr.writeUInt8(6, 9);   // RGBA
  ihdr.writeUInt8(0, 10);  // 无隔行
  const scanlines = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    scanlines[y * (size * 4 + 1)] = 0;   // filter: None
    rgba.copy(scanlines, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  const idat = zlib.deflateSync(scanlines, { level: 9 });
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}

// ---------- ICO 打包（PNG-in-ICO） ----------
function buildIco(entries) {
  const count = entries.length;
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); header.writeUInt16LE(1, 2); header.writeUInt16LE(count, 4);
  let offset = 6 + 16 * count;
  const parts = [header];
  for (const { size, data } of entries) {
    const e = Buffer.alloc(16);
    e.writeUInt8(size >= 256 ? 0 : size, 0);
    e.writeUInt8(size >= 256 ? 0 : size, 1);
    e.writeUInt8(0, 2); e.writeUInt8(0, 3);
    e.writeUInt16LE(1, 4); e.writeUInt16LE(32, 6);
    e.writeUInt32LE(data.length, 8);
    e.writeUInt32LE(offset, 12);
    parts.push(e);
    offset += data.length;
  }
  for (const { data } of entries) parts.push(data);
  return Buffer.concat(parts);
}

// ---------- 生成 ----------
fs.mkdirSync(BUILD_DIR, { recursive: true });
const pngs = {};
for (const size of [256, 48, 32, 16]) {
  pngs[size] = encodePng(downsample(size), size);
}
fs.writeFileSync(path.join(BUILD_DIR, 'icon.png'), pngs[256]);
fs.writeFileSync(path.join(BUILD_DIR, 'icon.ico'), buildIco(
  [256, 48, 32, 16].map((size) => ({ size, data: pngs[size] })),
));
console.log('图标生成完毕：build/icon.png  build/icon.ico（多尺寸 256/48/32/16 内嵌）');
