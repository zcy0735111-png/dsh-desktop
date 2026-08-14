'use strict';
// 纯 Node 冒烟测试（不启动 Electron）：验证 server.js 的拉起/健康检查/进程树清理逻辑。
// 用法：node scripts/manual-test.js [port]
const path = require('node:path');
const os = require('node:os');
const { ensureServer, killServerTree, httpProbe } = require('./server');

const port = Number(process.argv[2] || process.env.DSH_SMOKE_PORT || 3999);

(async () => {
  // 端口必须空闲
  const before = await httpProbe(port);
  if (before.ok) {
    console.error(`FAIL: 端口 ${port} 已被占用，无法测试。`);
    process.exit(1);
  }

  const info = await ensureServer({
    resourcesRoot: path.join(__dirname, '..'),
    workspace: os.homedir(),
    logFile: path.join(__dirname, '..', 'manual-server.log'),
    forcePort: port,
  });
  console.log(`READY url=${info.url} port=${info.port} spawned=${info.spawned} pid=${info.pid}`);

  // 再探一次确认仍是 DSH GUI
  const after = await httpProbe(port, 1500);
  console.log(`PROBE status=${after.status} isDshGui=${String(after.body).includes('DeepSeek Harness')}`);

  await new Promise((r) => setTimeout(r, 1000));
  await killServerTree(info.pid);
  console.log(`KILLED pid=${info.pid}`);

  // 确认端口已释放
  await new Promise((r) => setTimeout(r, 1000));
  const freed = await httpProbe(port, 800);
  console.log(freed.ok ? `FAIL: 端口 ${port} 仍在监听（清理失败）` : `OK: 端口 ${port} 已释放`);
  process.exit(freed.ok ? 1 : 0);
})().catch((e) => {
  console.error('FAIL:', e.message);
  process.exit(1);
});
