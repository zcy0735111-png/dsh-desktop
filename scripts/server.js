'use strict';
// DSH 服务器托管逻辑（纯 Node，不依赖 Electron，可独立测试）。
// 职责：定位 DSH 运行时 → 探测已有 GUI（挂接）→ 否则自动拉起 dsh web → 健康检查 → 退出时清理进程树。

const { spawn } = require('node:child_process');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const DEFAULT_FIRST_PORT = 3080; // dsh web 默认端口
const PORT_TRIES = 24;           // 最多探测 24 个端口
const READY_TIMEOUT_MS = 120_000;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// 探测 127.0.0.1:port 是否返回 DSH GUI 页面
function httpProbe(port, timeoutMs = 800) {
  return new Promise((resolve) => {
    const req = http.get(
      { host: '127.0.0.1', port, path: '/', timeout: timeoutMs },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (c) => {
          body += c;
          if (body.length > 200_000) req.destroy();
        });
        res.on('end', () => resolve({ ok: true, status: res.statusCode, body }));
        res.on('error', () => resolve({ ok: false }));
      },
    );
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve({ ok: false }));
  });
}

function isDshGui(res) {
  return (
    res.ok &&
    res.status === 200 &&
    res.body.includes('DeepSeek Harness') &&
    res.body.includes('__DSH_BOOT__')
  );
}

// 依次查找 DSH 运行时（@deepseek-ai/dsh 包，需含 lib/bin.js）：
// 1) DSH_DESKTOP_DSH_PATH 显式指定；2) 应用内置 resources/dsh；3) npm 的 npx 缓存（容忍哈希目录名变化）
function findDshRuntime({ resourcesRoot } = {}) {
  const candidates = [];
  if (process.env.DSH_DESKTOP_DSH_PATH) {
    candidates.push(process.env.DSH_DESKTOP_DSH_PATH);
  }
  if (resourcesRoot) {
    candidates.push(path.join(resourcesRoot, 'dsh', 'node_modules', '@deepseek-ai', 'dsh'));
  }
  const npxRoot = path.join(os.homedir(), 'AppData', 'Local', 'npm-cache', '_npx');
  let dirs = [];
  try {
    dirs = fs.readdirSync(npxRoot);
  } catch {
    /* 无 npx 缓存目录 */
  }
  for (const d of dirs) {
    candidates.push(path.join(npxRoot, d, 'node_modules', '@deepseek-ai', 'dsh'));
  }
  for (const c of candidates) {
    try {
      if (fs.statSync(path.join(c, 'lib', 'bin.js')).isFile()) return c;
    } catch {
      /* 继续 */
    }
  }
  return null;
}

function appendLog(logFile, text) {
  if (!logFile) return;
  try {
    fs.appendFileSync(logFile, text + '\n');
  } catch {
    /* 日志写失败不影响主流程 */
  }
}

// 选择 node 可执行文件：显式指定 > 应用内置 node > 系统 PATH
function resolveNode({ resourcesRoot } = {}) {
  if (process.env.DSH_DESKTOP_NODE) return process.env.DSH_DESKTOP_NODE;
  if (resourcesRoot) {
    const bundled = path.join(resourcesRoot, 'node', 'node.exe');
    try {
      if (fs.statSync(bundled).isFile()) return bundled;
    } catch {
      /* 未内置 */
    }
  }
  return 'node';
}

// 核心入口：确保 DSH GUI 可用，返回 { url, port, spawned, pid, runtime, child }
async function ensureServer(opts = {}) {
  const { resourcesRoot, workspace, logFile, forcePort } = opts;

  const runtime = findDshRuntime({ resourcesRoot });
  if (!runtime) {
    throw new Error(
      '未找到 DSH 运行时（@deepseek-ai/dsh）。\n' +
        '请运行 npm run bundle-dsh 打包内置运行时，或设置环境变量 DSH_DESKTOP_DSH_PATH 指向 dsh 包目录。',
    );
  }

  const firstPort = forcePort ?? DEFAULT_FIRST_PORT;

  // 1) 挂接已运行的 DSH GUI（不接管，退出时也不杀）
  if (!forcePort) {
    for (let i = 0; i < PORT_TRIES; i++) {
      const port = firstPort + i;
      const res = await httpProbe(port);
      if (isDshGui(res)) {
        appendLog(logFile, `[dsh-desktop] 已连接正在运行的 DSH 服务 http://127.0.0.1:${port}`);
        return { url: `http://127.0.0.1:${port}`, port, spawned: false, pid: null, runtime, child: null };
      }
    }
  }

  // 2) 找一个空闲端口（forcePort 时直接使用指定端口）
  let port = firstPort;
  if (!forcePort) {
    let found = null;
    for (let i = 0; i < PORT_TRIES; i++) {
      const p = firstPort + i;
      const res = await httpProbe(p);
      if (!res.ok) {
        found = p;
        break;
      }
    }
    if (found == null) {
      throw new Error(`${firstPort}–${firstPort + PORT_TRIES - 1} 端口全部被占用，无法启动 DSH 服务器。`);
    }
    port = found;
  }

  // 3) 拉起 dsh web
  const binJs = path.join(runtime, 'lib', 'bin.js');
  const node = resolveNode({ resourcesRoot });
  const child = spawn(node, [binJs, 'web', '--port', String(port)], {
    cwd: workspace || os.homedir(),
    env: {
      ...process.env,
      DSH_HOME: process.env.DSH_HOME || path.join(os.homedir(), '.dsh'),
    },
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  appendLog(logFile, `[dsh-desktop] 启动 DSH 服务器: ${node} ${binJs} web --port ${port} (pid=${child.pid})`);

  let out = '';
  child.stdout.on('data', (d) => {
    out += d;
    appendLog(logFile, '[server] ' + d.toString().trimEnd());
  });
  child.stderr.on('data', (d) => {
    out += d;
    appendLog(logFile, '[server:err] ' + d.toString().trimEnd());
  });

  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(
        `DSH 服务器启动失败（pid=${child.pid}, code=${child.exitCode}）。\n\n日志末尾：\n${out.slice(-2000)}`,
      );
    }
    const res = await httpProbe(port, 1500);
    if (isDshGui(res)) {
      appendLog(logFile, `[dsh-desktop] DSH 服务器就绪 http://127.0.0.1:${port}`);
      return { url: `http://127.0.0.1:${port}`, port, spawned: true, pid: child.pid, runtime, child };
    }
    await sleep(400);
  }
  await killServerTree(child.pid);
  throw new Error(`等待 DSH 服务器就绪超时（${READY_TIMEOUT_MS / 1000}s）。\n\n日志末尾：\n${out.slice(-2000)}`);
}

// 杀掉整个进程树（Windows 用 taskkill /T；其他平台 SIGTERM）
function killServerTree(pid) {
  return new Promise((resolve) => {
    if (!pid) return resolve();
    if (process.platform === 'win32') {
      const p = spawn('taskkill', ['/pid', String(pid), '/T', '/F'], {
        windowsHide: true,
        stdio: 'ignore',
      });
      p.on('exit', () => resolve());
      p.on('error', () => resolve());
      setTimeout(resolve, 5000); // 保险：最多等 5s
    } else {
      try {
        process.kill(pid, 'SIGTERM');
      } catch {
        /* 已退出 */
      }
      resolve();
    }
  });
}

module.exports = { ensureServer, killServerTree, findDshRuntime, httpProbe, isDshGui, sleep, appendLog };
