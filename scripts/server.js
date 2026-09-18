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

// 列出所有候选 DSH 运行时（含 lib/bin.js 的 @deepseek-ai/dsh 包目录），按优先级排序：
// 1) DSH_DESKTOP_DSH_PATH 显式指定；2) 应用内置 resources/dsh；3) npm 的 npx 缓存（容忍哈希目录名变化）
function listDshRuntimes({ resourcesRoot } = {}) {
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
  const out = [];
  for (const c of candidates) {
    try {
      if (fs.statSync(path.join(c, 'lib', 'bin.js')).isFile() && !out.includes(c)) out.push(c);
    } catch {
      /* 继续 */
    }
  }
  return out;
}

function findDshRuntime(opts = {}) {
  const list = listDshRuntimes(opts);
  return list.length ? list[0] : null;
}

// 在指定运行时所属的 node_modules 里查找某个 bundle 包
function runtimeHasBundle(runtime, bundleName) {
  const nodeModules = path.dirname(path.dirname(runtime)); // .../node_modules/@deepseek-ai/dsh -> .../node_modules
  try {
    return fs.statSync(path.join(nodeModules, bundleName, 'package.json')).isFile();
  } catch {
    return false;
  }
}

// 找一个"含有缺失 bundle"的其他 DSH 安装，用作回退运行时
function findRuntimeWithBundle(bundleName, { resourcesRoot, skip = [] } = {}) {
  for (const rt of listDshRuntimes({ resourcesRoot })) {
    if (skip.includes(rt)) continue;
    if (runtimeHasBundle(rt, bundleName)) return rt;
  }
  return null;
}

// 解析启动失败日志里的缺失 bundle 名（dsh 的报错格式见 dsh-app-boot:resolveBundleDir）。
// 注意：Node 打印未捕获异常时会回显抛错处的源码行（含 ${JSON.stringify(packageName)} 这类模板文本），
// 因此这里要求包名必须紧跟引号，避免误匹配源码行。
function parseMissingBundle(output) {
  const m = /cannot resolve profile bundle\s+["']([^"'\r\n]+)["']/.exec(output || '');
  if (!m) return null;
  const name = m[1].trim();
  if (!name || name.includes('${')) return null;
  return name;
}

function resolveDshHome() {
  return process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
}

// 从 profile 清单里移除一个无法解析的 bundle（先备份原文件）
function removeBundleFromProfile(manifestPath, bundleName) {
  const raw = fs.readFileSync(manifestPath, 'utf8');
  const json = JSON.parse(raw);
  const list = json && json.dsh && json.dsh.profile && json.dsh.profile.bundles;
  if (!Array.isArray(list)) {
    throw new Error(`profile 清单结构异常，未找到 dsh.profile.bundles: ${manifestPath}`);
  }
  const next = list.filter((b) => b !== bundleName);
  if (next.length === list.length) return { changed: false };
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backup = `${manifestPath}.bak-${stamp}`;
  fs.copyFileSync(manifestPath, backup);
  json.dsh.profile.bundles = next;
  fs.writeFileSync(manifestPath, JSON.stringify(json, null, 2) + '\n');
  return { changed: true, backup, before: list.length, after: next.length };
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
        return { url: `http://127.0.0.1:${port}`, port, spawned: false, pid: null, runtime, child: null, runtimeFallback: false };
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

  // 3) 拉起 dsh web：依次尝试候选运行时（内置优先），缺失第三方插件时自动回退到含该插件的安装
  const tried = [];
  const queue = listDshRuntimes({ resourcesRoot });
  let lastError = null;

  while (queue.length) {
    const runtime = queue.shift();
    if (tried.includes(runtime)) continue;
    tried.push(runtime);

    const attempt = await tryBoot(runtime, port, { workspace, logFile, resourcesRoot });
    if (attempt.ok) {
      return {
        url: attempt.url,
        port,
        spawned: true,
        pid: attempt.child.pid,
        runtime,
        child: attempt.child,
        runtimeFallback: tried.length > 1,
      };
    }

    const missing = parseMissingBundle(attempt.output);
    if (missing) {
      appendLog(logFile, `[dsh-desktop] 运行时缺少插件 bundle: ${missing}`);
      const alt = findRuntimeWithBundle(missing, { resourcesRoot, skip: tried });
      if (alt) {
        appendLog(logFile, `[dsh-desktop] 回退到含该插件的运行时: ${alt}`);
        queue.unshift(alt);
        continue;
      }
      // 没有可用替代 → 抛结构化错误，由界面询问是否忽略该插件
      const manifest = path.join(resolveDshHome(), 'profiles', 'web', 'package.json');
      const err = new Error(
        `DSH 配置引用了插件 ${missing}，但内置运行时和本机其他 DSH 安装里都没有它。\n\n` +
          `配置文件：${manifest}\n\n` +
          `可以忽略该插件继续启动（会先自动备份原配置）。`,
      );
      err.missingBundle = missing;
      err.profileManifest = manifest;
      err.canRepair = fs.existsSync(manifest);
      throw err;
    }
    lastError = attempt.timeout
      ? new Error(`等待 DSH 服务器就绪超时（${READY_TIMEOUT_MS / 1000}s）。\n\n日志末尾：\n${attempt.output.slice(-2000)}`)
      : new Error(
          `DSH 服务器启动失败（pid=${attempt.child.pid}, code=${attempt.child.exitCode}）。\n\n日志末尾：\n${attempt.output.slice(-2000)}`,
        );
    break; // 非插件类失败：不再换运行时重试
  }

  throw lastError || new Error('没有可用的 DSH 运行时。');
}

// 用指定运行时启动一次 dsh web，等它就绪
async function tryBoot(runtime, port, { workspace, logFile, resourcesRoot }) {
  const binJs = path.join(runtime, 'lib', 'bin.js');
  const node = resolveNode({ resourcesRoot });
  const child = spawn(node, [binJs, 'web', '--port', String(port)], {
    cwd: workspace || os.homedir(),
    env: {
      ...process.env,
      DSH_HOME: resolveDshHome(),
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
      return { ok: false, child, output: out };
    }
    const res = await httpProbe(port, 1500);
    if (isDshGui(res)) {
      appendLog(logFile, `[dsh-desktop] DSH 服务器就绪 http://127.0.0.1:${port}`);
      return { ok: true, child, output: out, url: `http://127.0.0.1:${port}` };
    }
    await sleep(400);
  }
  await killServerTree(child.pid);
  return { ok: false, child, output: out, timeout: true };
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

module.exports = {
  ensureServer,
  killServerTree,
  findDshRuntime,
  listDshRuntimes,
  findRuntimeWithBundle,
  parseMissingBundle,
  removeBundleFromProfile,
  resolveDshHome,
  httpProbe,
  isDshGui,
  sleep,
  appendLog,
};
