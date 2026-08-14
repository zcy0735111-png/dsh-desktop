'use strict';
// 纯 Node 生成应用图标（无第三方依赖）：
//   resources/icon.png  (512x512)
//   resources/icon.ico  (256x256，PNG 内嵌格式，Vista+ 支持)
// 图案：DeepSeek 蓝渐变圆角方块 + 白色聊天气泡 + 三个圆点。
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

// ---------- 最小 PNG 编码器（RGBA 8bit） ----------
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const t = Buffer.from(type, 'ascii');
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([t, data])));
  return Buffer.concat([len, t, data, crc]);
}

function encodePng(w, h, rgba) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  const stride = w * 4;
  const raw = Buffer.alloc((stride + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (stride + 1)] = 0; // filter: None
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  return Buffer.concat([
    sig,
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function encodeIco(png) {
  // 单条目 256x256（ICO 中用 0 表示 256）
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(1, 4); // count
  const entry = Buffer.alloc(16);
  entry[0] = 0; // width 256
  entry[1] = 0; // height 256
  entry[2] = 0; // palette
  entry[3] = 0; // reserved
  entry.writeUInt16LE(1, 4); // planes
  entry.writeUInt16LE(32, 6); // bpp
  entry.writeUInt32LE(png.length, 8);
  entry.writeUInt32LE(22, 12); // offset
  return Buffer.concat([header, entry, png]);
}

// ---------- 绘制 ----------
const SS = 4; // 4x 超采样抗锯齿

function makeIcon(size) {
  const S = size * SS;
  const px = new Float64Array(S * S * 4);

  const lerp = (a, b, t) => a + (b - a) * t;
  const mix = (c1, c2, t) => [lerp(c1[0], c2[0], t), lerp(c1[1], c2[1], t), lerp(c1[2], c2[2], t)];

  const C_TOP = [0x5b, 0x7c, 0xfa]; // #5B7CFA
  const C_BOT = [0x24, 0x3f, 0xc9]; // #243FC9
  const C_DOT = [0x3b, 0x5b, 0xdb]; // #3B5BDB

  // 形状（逻辑坐标 0..1，归一化到像素）
  const rect = { x: 0.05, y: 0.05, w: 0.9, h: 0.9, r: 0.2 }; // 圆角方块
  const bubble = { x: 0.24, y: 0.24, w: 0.52, h: 0.38, r: 0.07 }; // 气泡
  const tail = [
    [0.34, 0.62],
    [0.5, 0.62],
    [0.38, 0.78],
  ]; // 气泡尾巴（左下）
  const dots = [
    [0.33, 0.43, 0.05],
    [0.5, 0.43, 0.05],
    [0.67, 0.43, 0.05],
  ]; // 三个圆点 [x, y, r]

  const inRoundRect = (px_, py_, x, y, w, h, r) => {
    const cx = Math.max(x + r, Math.min(px_, x + w - r));
    const cy = Math.max(y + r, Math.min(py_, y + h - r));
    const dx = px_ - cx;
    const dy = py_ - cy;
    return dx * dx + dy * dy <= r * r;
  };
  const inCircle = (px_, py_, cx, cy, r) => {
    const dx = px_ - cx;
    const dy = py_ - cy;
    return dx * dx + dy * dy <= r * r;
  };
  const inTriangle = (px_, py_, a, b, c) => {
    const s1 = (b[0] - a[0]) * (py_ - a[1]) - (b[1] - a[1]) * (px_ - a[0]);
    const s2 = (c[0] - b[0]) * (py_ - b[1]) - (c[1] - b[1]) * (px_ - b[0]);
    const s3 = (a[0] - c[0]) * (py_ - c[1]) - (a[1] - c[1]) * (px_ - c[0]);
    return (s1 >= 0 && s2 >= 0 && s3 >= 0) || (s1 <= 0 && s2 <= 0 && s3 <= 0);
  };

  for (let y = 0; y < S; y++) {
    const ny = (y + 0.5) / S;
    for (let x = 0; x < S; x++) {
      const nx = (x + 0.5) / S;
      let r = 0,
        g = 0,
        b = 0,
        a = 0;
      // 背景圆角方块（垂直渐变）
      if (inRoundRect(nx, ny, rect.x, rect.y, rect.w, rect.h, rect.r)) {
        const [cr, cg, cb] = mix(C_TOP, C_BOT, ny);
        r += cr;
        g += cg;
        b += cb;
        a += 255;
      }
      // 白色气泡（覆盖在方块上）
      if (inRoundRect(nx, ny, bubble.x, bubble.y, bubble.w, bubble.h, bubble.r) || inTriangle(nx, ny, ...tail)) {
        r = (r * (a / 255) + 255 * 1) / (a / 255 + 1);
        g = (g * (a / 255) + 255 * 1) / (a / 255 + 1);
        b = (b * (a / 255) + 255 * 1) / (a / 255 + 1);
        a = Math.min(255, a + 255);
      }
      // 圆点
      for (const [dx, dy, dr] of dots) {
        if (inCircle(nx, ny, dx, dy, dr)) {
          r = C_DOT[0];
          g = C_DOT[1];
          b = C_DOT[2];
          a = 255;
        }
      }
      const i = (y * S + x) * 4;
      px[i] = r;
      px[i + 1] = g;
      px[i + 2] = b;
      px[i + 3] = a;
    }
  }

  // 4x4 块降采样
  const out = Buffer.alloc(size * size * 4);
  const B = SS * SS;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0,
        g = 0,
        b = 0,
        a = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const i = ((y * SS + sy) * S + (x * SS + sx)) * 4;
          r += px[i];
          g += px[i + 1];
          b += px[i + 2];
          a += px[i + 3];
        }
      }
      const o = (y * size + x) * 4;
      out[o] = Math.round(r / B);
      out[o + 1] = Math.round(g / B);
      out[o + 2] = Math.round(b / B);
      out[o + 3] = Math.round(a / B);
    }
  }
  return out;
}

const resources = path.join(__dirname, '..', 'resources');
fs.mkdirSync(resources, { recursive: true });

const png512 = encodePng(512, 512, makeIcon(512));
fs.writeFileSync(path.join(resources, 'icon.png'), png512);
console.log(`icon.png ${(png512.length / 1024).toFixed(1)} KB`);

const png256 = encodePng(256, 256, makeIcon(256));
const ico = encodeIco(png256);
fs.writeFileSync(path.join(resources, 'icon.ico'), ico);
console.log(`icon.ico ${(ico.length / 1024).toFixed(1)} KB`);
