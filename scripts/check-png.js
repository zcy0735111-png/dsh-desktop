'use strict';
// PNG 检查工具：解码 PNG，输出尺寸、字节数、唯一颜色数、亮度直方图与 24x18 ASCII 预览。
// 用法：node scripts/check-png.js <file.png>
const fs = require('node:fs');
const zlib = require('node:zlib');

function decodePng(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('不是 PNG 文件');
  let pos = 8;
  let width = 0,
    height = 0,
    bitDepth = 0,
    colorType = 0;
  const idat = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('ascii', pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
    } else if (type === 'IDAT') {
      idat.push(data);
    } else if (type === 'IEND') {
      break;
    }
    pos += 12 + len;
  }
  if (bitDepth !== 8) throw new Error(`不支持的位深 ${bitDepth}`);
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const channels = colorType === 6 ? 4 : colorType === 2 ? 3 : 1;
  const stride = width * channels;
  const pixels = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) {
    const row = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let x = 0; x < width; x++) {
      const si = x * channels;
      const di = (y * width + x) * 4;
      pixels[di] = row[si];
      pixels[di + 1] = channels >= 3 ? row[si + 1] : row[si];
      pixels[di + 2] = channels >= 3 ? row[si + 2] : row[si];
      pixels[di + 3] = channels === 4 ? row[si + 3] : 255;
    }
  }
  return { width, height, pixels };
}

const file = process.argv[2];
if (!file) {
  console.error('用法: node scripts/check-png.js <file.png>');
  process.exit(1);
}
const buf = fs.readFileSync(file);
const { width, height, pixels } = decodePng(buf);

const colors = new Set();
let opaque = 0,
  nonBlack = 0;
for (let i = 0; i < pixels.length; i += 4) {
  const r = pixels[i],
    g = pixels[i + 1],
    b = pixels[i + 2],
    a = pixels[i + 3];
  colors.add((r << 16) | (g << 8) | b);
  if (a > 200) opaque++;
  if (r + g + b > 60) nonBlack++;
}

// ASCII 预览（40x26），亮度按内容自适应归一化
const CW = 40,
  CH = 26;
const ramp = ' .:-=+*#%@';
// 先算内容亮度分布（95 分位），作为归一化基准
const brightness = [];
for (let i = 0; i < pixels.length; i += 4) {
  if (pixels[i + 3] > 100) brightness.push((pixels[i] + pixels[i + 1] + pixels[i + 2]) / 3);
}
brightness.sort((a, b) => a - b);
const norm = Math.max(60, brightness[Math.floor(brightness.length * 0.95)] || 255);
console.log(`\n${file}`);
console.log(`尺寸 ${width}x${height} | 字节 ${buf.length} | 唯一颜色 ${colors.size} | 不透明像素 ${((opaque / (width * height)) * 100).toFixed(1)}% | 非黑像素 ${((nonBlack / (width * height)) * 100).toFixed(1)}%`);
console.log('-'.repeat(CW));
for (let cy = 0; cy < CH; cy++) {
  let line = '';
  for (let cx = 0; cx < CW; cx++) {
    const cell = [];
    for (let y = Math.floor((cy * height) / CH); y < Math.floor(((cy + 1) * height) / CH); y++) {
      for (let x = Math.floor((cx * width) / CW); x < Math.floor(((cx + 1) * width) / CW); x++) {
        const i = (y * width + x) * 4;
        if (pixels[i + 3] > 100) cell.push((pixels[i] + pixels[i + 1] + pixels[i + 2]) / 3);
      }
    }
    if (!cell.length) {
      line += ' ';
      continue;
    }
    cell.sort((a, b) => a - b);
    const p95 = cell[Math.floor(cell.length * 0.95)];
    line += p95 > 40 ? ramp[Math.min(9, Math.floor((p95 / 255) * 10))] : ' ';
  }
  console.log(line);
}
console.log('-'.repeat(CW));
