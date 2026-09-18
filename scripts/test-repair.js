'use strict';
// 复现"profile 引用了缺失第三方插件"的故障，并验证修复链路：
//   1) ensureServer 抛出带 missingBundle 的结构化错误
//   2) removeBundleFromProfile 备份并移除该插件
//   3) 修复后 ensureServer 正常启动
// 用法：node scripts/test-repair.js [port]
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { ensureServer, killServerTree, httpProbe, removeBundleFromProfile, parseMissingBundle } = require('./server');

const FAKE_BUNDLE = '@linenxi-trt/dsh-vision'; // 与朋友机器上缺失的插件一致
const port = Number(process.argv[2] || 3996);
const home = path.join(__dirname, '..', '.test-broken-home');
const profileDir = path.join(home, 'profiles', 'web');
const manifest = path.join(profileDir, 'package.json');

function fail(msg) {
  console.error('FAIL: ' + msg);
  process.exit(1);
}

(async () => {
  // 构造损坏的 profile 清单
  fs.rmSync(home, { recursive: true, force: true });
  fs.mkdirSync(profileDir, { recursive: true });
  fs.writeFileSync(
    manifest,
    JSON.stringify(
      {
        name: 'dsh-profile-web',
        private: true,
        dependencies: {},
        dsh: {
          profile: {
            bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', FAKE_BUNDLE],
          },
        },
      },
      null,
      2,
    ) + '\n',
  );
  process.env.DSH_HOME = home;
  console.log(`测试 DSH_HOME: ${home}`);
  console.log(`清单 bundles: ${JSON.parse(fs.readFileSync(manifest, 'utf8')).dsh.profile.bundles.join(', ')}`);

  const opts = {
    resourcesRoot: path.join(__dirname, '..'),
    workspace: os.homedir(),
    logFile: path.join(__dirname, '..', 'test-repair.log'),
    forcePort: port,
  };

  // 1) 应当失败并给出 missingBundle
  let err = null;
  try {
    await ensureServer(opts);
  } catch (e) {
    err = e;
  }
  if (!err) fail('缺失插件时竟然启动成功了');
  if (err.missingBundle !== FAKE_BUNDLE) fail(`missingBundle 解析错误: ${err.missingBundle}`);
  console.log(`OK 1/4: 正确识别缺失插件 ${err.missingBundle}`);
  console.log(`      canRepair=${err.canRepair} manifest=${err.profileManifest}`);
  if (!err.canRepair) fail('canRepair 应为 true（清单文件存在）');

  // 解析函数单独校验
  if (parseMissingBundle('dsh: cannot resolve profile bundle "@x/y" from the dsh installation') !== '@x/y') {
    fail('parseMissingBundle 正则不匹配');
  }
  console.log('OK 2/4: parseMissingBundle 解析正确');

  // 2) 修复：备份 + 移除
  const r = removeBundleFromProfile(manifest, FAKE_BUNDLE);
  if (!r.changed) fail('removeBundleFromProfile 未做修改');
  if (!fs.existsSync(r.backup)) fail('备份文件不存在');
  const after = JSON.parse(fs.readFileSync(manifest, 'utf8')).dsh.profile.bundles;
  if (after.includes(FAKE_BUNDLE)) fail('移除后清单里仍有该插件');
  console.log(`OK 3/4: 已备份 (${path.basename(r.backup)}) 并移除插件，剩余 bundles: ${after.join(', ')}`);

  // 3) 修复后应能正常启动
  const info = await ensureServer(opts);
  console.log(`OK 4/4: 修复后启动成功 url=${info.url} pid=${info.pid}`);
  await killServerTree(info.pid);
  await new Promise((res) => setTimeout(res, 800));
  const freed = await httpProbe(port, 800);
  console.log(freed.ok ? `FAIL: 端口 ${port} 未释放` : `OK: 端口 ${port} 已释放，测试全部通过`);
  process.exit(freed.ok ? 1 : 0);
})().catch((e) => fail(e.stack || e.message));
