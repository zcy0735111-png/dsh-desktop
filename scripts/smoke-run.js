'use strict';
// 冒烟测试运行器：以指定环境变量启动 Electron 并透传退出码。
// 用法：node scripts/smoke-run.js [--spawn]
//   --spawn  强制走"自拉服务器"路径（DSH_DESKTOP_FORCE_PORT，默认 3999），用于验证拉起+清理
//   不带     验证"挂接已有服务"路径
const { spawn } = require('node:child_process');
const path = require('node:path');
const electron = require('electron'); // 在 Node 中 require('electron') 返回二进制路径

const spawnMode = process.argv.includes('--spawn');
const outFile = spawnMode ? 'smoke-spawn.png' : 'smoke.png';

const env = {
  ...process.env,
  DSH_DESKTOP_SMOKE: '1',
  DSH_DESKTOP_SMOKE_OUT: path.join(__dirname, '..', outFile),
  DSH_DESKTOP_USERDATA: path.join(__dirname, '..', '.smoke-userdata'),
  // 冒烟测试使用独立的 DSH_HOME，避免污染真实配置、也避免与正在运行的实例抢文件
  DSH_HOME: path.join(__dirname, '..', '.smoke-dsh-home'),
};
if (spawnMode) {
  env.DSH_DESKTOP_FORCE_PORT = process.env.DSH_SMOKE_PORT || '3999';
}

const child = spawn(electron, ['.'], { env, stdio: 'inherit' });
child.on('exit', (code) => process.exit(code ?? 1));
