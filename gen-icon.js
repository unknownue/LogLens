// 生成 LogLens 应用图标源图（1024x1024，4x 超采样抗锯齿）。
// 设计：深色圆角方块 + 四行日志文本（首行青色强调）+ 行尾光标块，终端风格。
// 用法：node gen-icon.js <输出目录>
const fs = require("fs");
const zlib = require("zlib");
const path = require("path");

const S = 1024;              // 输出尺寸
const SS = 4;                // 超采样倍数
const R = 225;               // 圆角半径
const TOP = [27, 37, 52];    // #1b2534
const BOT = [38, 55, 77];    // #26374d
const INK = [223, 232, 243]; // #dfe8f3 日志文字
const ACC = [52, 216, 224];  // #34d8e0 强调色

// 四条日志行（胶囊形：x0, y0, w, h）
const LINE_H = 72;
const GAP = 104;
const X0 = 280;
const LINES = [
  { w: 464, accent: true },
  { w: 344, accent: false },
  { w: 424, accent: false },
  { w: 256, accent: false },
];
const TOTAL_H = LINES.length * LINE_H + (LINES.length - 1) * GAP;
let yCursor = (S - TOTAL_H) / 2;
const SHAPES = [];
for (const l of LINES) {
  SHAPES.push({ x0: X0, y0: yCursor, x1: X0 + l.w, y1: yCursor + LINE_H, color: l.accent ? ACC : INK });
  yCursor += LINE_H + GAP;
}
// 行尾光标块
const last = SHAPES[SHAPES.length - 1];
SHAPES.push({
  x0: last.x1 + 36, y0: last.y0, x1: last.x1 + 36 + LINE_H, y1: last.y1,
  color: ACC,
  square: true,
});

function inCapsule(s, x, y) {
  const r = (s.y1 - s.y0) / 2;
  const cx = Math.max(s.x0 + r, Math.min(x, s.x1 - r));
  const cy = Math.max(s.y0 + r, Math.min(y, s.y1 - r));
  const dx = x - cx, dy = y - cy;
  return dx * dx + dy * dy <= r * r;
}
function inRect(s, x, y) {
  return x >= s.x0 && x <= s.x1 && y >= s.y0 && y <= s.y1;
}

function sample(x, y) {
  // 圆角方块内部测试
  const cx = Math.max(R, Math.min(x, S - R));
  const cy = Math.max(R, Math.min(y, S - R));
  const dx = x - cx, dy = y - cy;
  if (dx * dx + dy * dy > R * R) return null;
  // 背景渐变
  const t = y / S;
  let c = [
    TOP[0] + (BOT[0] - TOP[0]) * t,
    TOP[1] + (BOT[1] - TOP[1]) * t,
    TOP[2] + (BOT[2] - TOP[2]) * t,
  ];
  for (const s of SHAPES) {
    if (s.square ? inRect(s, x, y) : inCapsule(s, x, y)) {
      c = s.color;
      break;
    }
  }
  return c;
}

// 逐像素 4x4 超采样 + 均值混合（含透明）
const raw = Buffer.alloc(S * S * 4);
for (let y = 0; y < S; y++) {
  for (let x = 0; x < S; x++) {
    let r = 0, g = 0, b = 0, a = 0;
    for (let sy = 0; sy < SS; sy++) {
      for (let sx = 0; sx < SS; sx++) {
        const c = sample(x + (sx + 0.5) / SS, y + (sy + 0.5) / SS);
        if (c) { r += c[0]; g += c[1]; b += c[2]; a += 255; }
      }
    }
    const n = SS * SS;
    const i = (y * S + x) * 4;
    raw[i] = Math.round(r / n);
    raw[i + 1] = Math.round(g / n);
    raw[i + 2] = Math.round(b / n);
    raw[i + 3] = Math.round(a / n);
  }
}

// ---- PNG 编码 ----
const crcTable = (() => {
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
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
function encodePng(w, h, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // RGBA
  const stride = w * 4;
  const scan = Buffer.alloc((stride + 1) * h);
  for (let y = 0; y < h; y++) {
    scan[y * (stride + 1)] = 0; // filter none
    rgba.copy(scan, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(scan, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// ---- 降采样（盒式滤波） ----
function boxScale(w0, h0, src, w, h) {
  const out = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const x0 = Math.floor((x * w0) / w), x1 = Math.max(x0 + 1, Math.ceil(((x + 1) * w0) / w));
      const y0 = Math.floor((y * h0) / h), y1 = Math.max(y0 + 1, Math.ceil(((y + 1) * h0) / h));
      let r = 0, g = 0, b = 0, a = 0;
      for (let yy = y0; yy < y1; yy++) {
        for (let xx = x0; xx < x1; xx++) {
          const i = (yy * w0 + xx) * 4;
          const al = src[i + 3];
          r += src[i] * al; g += src[i + 1] * al; b += src[i + 2] * al; a += al;
        }
      }
      const i = (y * w + x) * 4;
      const n = (x1 - x0) * (y1 - y0);
      if (a > 0) {
        out[i] = Math.round(r / a);
        out[i + 1] = Math.round(g / a);
        out[i + 2] = Math.round(b / a);
        out[i + 3] = Math.round(a / n);
      }
    }
  }
  return out;
}

// ---- 组装 icon.ico（PNG 条目，Vista+ 全尺寸支持） ----
function buildIco(sizes) {
  const datas = sizes.map(({ w, h, png }) => png);
  const offset0 = 6 + 16 * datas.length;
  const header = Buffer.alloc(offset0);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2); // type = icon
  header.writeUInt16LE(datas.length, 4);
  let off = offset0;
  sizes.forEach((s, i) => {
    const e = header.subarray(6 + i * 16, 6 + i * 16 + 16);
    e[0] = s.w >= 256 ? 0 : s.w;
    e[1] = s.h >= 256 ? 0 : s.h;
    e[2] = 0; // palette
    e[3] = 0; // reserved
    e.writeUInt16LE(1, 4);  // planes
    e.writeUInt16LE(32, 6); // bpp
    e.writeUInt32LE(datas[i].length, 8);
    e.writeUInt32LE(off, 12);
    off += datas[i].length;
  });
  return Buffer.concat([header, ...datas]);
}

const outDir = process.argv[2] || ".";
const src1024 = raw;
const files = [
  ["icon-source-1024.png", encodePng(S, S, src1024)],
  ["icon.png", encodePng(S, S, src1024)],
  ["512x512.png", encodePng(512, 512, boxScale(S, S, src1024, 512, 512))],
  ["128x128@2x.png", encodePng(256, 256, boxScale(S, S, src1024, 256, 256))],
  ["128x128.png", encodePng(128, 128, boxScale(S, S, src1024, 128, 128))],
  ["32x32.png", encodePng(32, 32, boxScale(S, S, src1024, 32, 32))],
];
for (const [name, data] of files) {
  fs.writeFileSync(path.join(outDir, name), data);
  console.log("wrote", name, data.length, "bytes");
}
// icon.ico: 16/24/32/48/64/128/256
const icoSizes = [16, 24, 32, 48, 64, 128, 256];
const sizes = icoSizes.map((s) => ({
  w: s,
  h: s,
  png: encodePng(s, s, boxScale(S, S, src1024, s, s)),
}));
fs.writeFileSync(path.join(outDir, "icon.ico"), buildIco(sizes));
console.log("wrote icon.ico with", icoSizes.join("/"), "sizes");
