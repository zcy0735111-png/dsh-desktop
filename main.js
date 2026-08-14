'use strict';
// DSH Desktop 主进程：挂接或拉起 DSH 服务器 → 打开原生窗口 → 退出时清理自启进程。

const { app, BrowserWindow, dialog, shell } = require('electron');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const { ensureServer, killServerTree, sleep } = require('./scripts/server');

const isSmoke = process.env.DSH_DESKTOP_SMOKE === '1';
const smokeOut = process.env.DSH_DESKTOP_SMOKE_OUT;
const forcePort = process.env.DSH_DESKTOP_FORCE_PORT
  ? Number(process.env.DSH_DESKTOP_FORCE_PORT)
  : undefined;

// 冒烟/测试模式下把用户数据目录放到工作区内（沙箱环境写不了 %APPDATA%）
if (process.env.DSH_DESKTOP_USERDATA) {
  app.setPath('userData', process.env.DSH_DESKTOP_USERDATA);
}

let win = null;
let serverInfo = null;
let shuttingDown = false;

function resourcesRoot() {
  return app.isPackaged ? process.resourcesPath : path.join(__dirname, 'resources');
}

function logFile() {
  return path.join(app.getPath('userData'), 'server.log');
}

function serverOpts() {
  return {
    resourcesRoot: resourcesRoot(),
    workspace: os.homedir(),
    logFile: logFile(),
    forcePort,
  };
}

// 统一退出：先清理自启的服务器进程树，再退出
async function shutdown(code) {
  if (shuttingDown) return;
  shuttingDown = true;
  if (serverInfo && serverInfo.spawned && serverInfo.pid) {
    console.log(`[dsh-desktop] 停止自启服务器 pid=${serverInfo.pid}`);
    await killServerTree(serverInfo.pid);
  }
  app.exit(code);
}

async function restartServer() {
  try {
    serverInfo = await ensureServer(serverOpts());
    if (win && !win.isDestroyed()) {
      win.loadURL(serverInfo.url);
    }
  } catch (err) {
    dialog.showErrorBox('DSH Desktop 重启失败', String(err));
    app.quit();
  }
}

async function main() {
  app.setAppUserModelId('ai.deepseek.dsh.desktop');

  // 窗口图标（开发模式下用项目内的 png/ico）
  let iconPath = null;
  for (const p of [path.join(resourcesRoot(), 'icon.png'), path.join(resourcesRoot(), 'icon.ico')]) {
    if (fs.existsSync(p)) {
      iconPath = p;
      break;
    }
  }

  // 1) 确保 DSH 服务器可用（挂接已有实例，或自动拉起）
  try {
    serverInfo = await ensureServer(serverOpts());
  } catch (err) {
    console.error('[dsh-desktop] 服务器启动失败:', err);
    if (isSmoke) {
      if (smokeOut) fs.writeFileSync(smokeOut + '.fail', String(err));
      app.exit(2);
      return;
    }
    dialog.showErrorBox('DSH Desktop 启动失败', String(err));
    app.exit(1);
    return;
  }

  // 2) 打开原生窗口
  win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 980,
    minHeight: 640,
    title: 'DSH Desktop',
    icon: iconPath || undefined,
    autoHideMenuBar: true,
    backgroundColor: '#0d1117',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  // 新窗口（target=_blank / window.open）一律交给系统浏览器
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
  win.on('closed', () => {
    win = null;
  });

  try {
    await win.loadURL(serverInfo.url);
  } catch (err) {
    console.error('[dsh-desktop] 加载 GUI 失败:', err);
    dialog.showErrorBox('DSH Desktop 加载失败', String(err));
    app.exit(1);
    return;
  }

  // 3) 监控自启服务器：意外退出时提示并尝试重启
  if (serverInfo.child) {
    serverInfo.child.on('exit', (code) => {
      if (shuttingDown || !win) return;
      console.error(`[dsh-desktop] 服务器进程意外退出 code=${code}`);
      const choice = dialog.showMessageBoxSync(win, {
        type: 'error',
        buttons: ['重新启动', '退出'],
        title: 'DSH 服务器已停止',
        message: `DSH 服务器进程意外退出（code=${code}）。是否重新启动？`,
      });
      if (choice === 0) {
        restartServer();
      } else {
        app.quit();
      }
    });
  }

  // 4) 冒烟测试模式：截图后退出
  if (isSmoke) {
    await sleep(5000); // 等 UI 渲染稳定
    try {
      const diag = await win.webContents.executeJavaScript(
        `JSON.stringify({
          title: document.title,
          url: location.href,
          bodyText: (document.body.innerText || '').slice(0, 600),
          rootChildren: document.body ? document.body.children.length : -1
        })`,
      );
      console.log('DSH-DESKTOP-SMOKE-DIAG ' + diag);
    } catch (e) {
      console.log('DSH-DESKTOP-SMOKE-DIAG-FAIL ' + String(e));
    }
    // 窗口可能被遮挡导致 Chromium 停止产帧（capturePage 会返回空图），先置前并关闭后台节流
    win.show();
    win.focus();
    win.webContents.setBackgroundThrottling(false);
    win.webContents.invalidate();
    await sleep(1500);
    const img = await win.webContents.capturePage();
    const sz = img.getSize();
    console.log(`DSH-DESKTOP-SMOKE-SHOT size=${sz.width}x${sz.height} empty=${img.isEmpty()}`);
    const out = smokeOut || path.join(app.getPath('userData'), 'smoke.png');
    fs.writeFileSync(out, img.toPNG());
    console.log(
      `DSH-DESKTOP-SMOKE-OK url=${serverInfo.url} spawned=${serverInfo.spawned} pid=${serverInfo.pid ?? 0} shot=${out}`,
    );
    await shutdown(0);
  }
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });
  app.whenReady().then(main);
}

app.on('window-all-closed', () => {
  app.quit();
});

app.on('before-quit', (e) => {
  if (!shuttingDown) {
    e.preventDefault();
    shutdown(0);
  }
});
