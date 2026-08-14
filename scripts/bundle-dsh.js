'use strict';
// 把当前机器上安装的 @deepseek-ai/dsh 完整运行时复制进 resources/dsh，
// 使打包后的应用自带 DSH，不依赖 npx 缓存。
// 来源优先级：DSH_DESKTOP_DSH_PATH（dsh 包目录）> npx 缓存安装。
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

function findSourcePkg() {
  if (process.env.DSH_DESKTOP_DSH_PATH) {
    const p = process.env.DSH_DESKTOP_DSH_PATH;
    if (fs.existsSync(path.join(p, 'lib', 'bin.js'))) {
      return { pkg: p, root: path.dirname(path.dirname(p)) }; // node_modules/@deepseek-ai/dsh -> 上两级是 node_modules
    }
    console.warn(`DSH_DESKTOP_DSH_PATH 指向的目录没有 lib/bin.js: ${p}`);
  }
  const npxRoot = path.join(os.homedir(), 'AppData', 'Local', 'npm-cache', '_npx');
  let dirs = [];
  try {
    dirs = fs.readdirSync(npxRoot);
  } catch {
    /* ignore */
  }
  for (const d of dirs) {
    const pkg = path.join(npxRoot, d, 'node_modules', '@deepseek-ai', 'dsh');
    if (fs.existsSync(path.join(pkg, 'lib', 'bin.js'))) {
      return { pkg, root: path.join(npxRoot, d) };
    }
  }
  return null;
}

function dirSize(dir) {
  let total = 0;
  try {
    for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, f.name);
      if (f.isDirectory()) total += dirSize(p);
      else if (f.isFile()) total += fs.statSync(p).size;
    }
  } catch {
    /* ignore */
  }
  return total;
}

// 1) 内置 node.exe（应用零依赖分发的关键：server 优先使用内置 node，ABI 与原生模块一致）
const nodeSrc = process.execPath; // 当前运行的 node 二进制
const nodeDest = path.join(__dirname, '..', 'resources', 'node', 'node.exe');
fs.mkdirSync(path.dirname(nodeDest), { recursive: true });
let needNodeCopy = true;
try {
  needNodeCopy = fs.statSync(nodeDest).size !== fs.statSync(nodeSrc).size;
} catch {
  /* 目标不存在则复制 */
}
if (needNodeCopy) {
  fs.copyFileSync(nodeSrc, nodeDest);
}
console.log(`node.exe ${needNodeCopy ? '已复制' : '已存在（版本一致，跳过）'} ${(fs.statSync(nodeDest).size / 1048576).toFixed(1)} MB (来源 ${nodeSrc})`);

// 2) 内置 DSH 运行时
const src = findSourcePkg();
if (!src) {
  console.error('未找到 DSH 运行时。请先安装 @deepseek-ai/dsh（npx @deepseek-ai/dsh --version）或设置 DSH_DESKTOP_DSH_PATH。');
  process.exit(1);
}

const dest = path.join(__dirname, '..', 'resources', 'dsh');
if (fs.existsSync(dest)) {
  console.log(`resources/dsh 已存在（${(dirSize(dest) / 1048576).toFixed(1)} MB），跳过复制。`);
} else {
  console.log(`来源: ${src.root}`);
  console.log(`目标: ${dest}`);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.cpSync(src.root, dest, { recursive: true });

  const check = path.join(dest, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');
  if (!fs.existsSync(check)) {
    console.error('复制后校验失败：缺少 lib/bin.js');
    process.exit(1);
  }
  console.log(`完成: ${(dirSize(dest) / 1048576).toFixed(1)} MB（含内置运行时校验通过）`);
}
