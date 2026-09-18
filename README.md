# DSH Desktop — DeepSeek Harness 桌面版

把 DeepSeek Harness 的 Web GUI 封装成 Windows 原生桌面应用：

- 双击即用，独立窗口运行 GUI（不再依赖浏览器标签页）
- 自动托管本地服务器：启动时若检测到已有 DSH 服务（`3080` 起）就直接挂接；否则自动拉起 `dsh web`（隐藏窗口、日志落盘）
- 关闭窗口时只清理**自己拉起的**服务器进程，不会误杀你手动启动的实例
- 复用你的现有配置（`DSH_HOME`，默认 `C:\Users\<用户>\.dsh`），会话、凭据、设置全部延续
- 可打包为完全自包含的应用（内置 DSH 运行时 + node.exe，接收方零依赖）

## 快速开始（开发模式）

```powershell
npm install          # 安装 Electron（首次需下载 ~120MB）
npm start            # 启动：挂接已有服务，或自动拉起一个
```

## 打包成桌面应用

```powershell
npm run dist         # 内置 DSH 运行时 + node.exe → dist/win-unpacked/DSH Desktop.exe（免安装，直接双击）
npm run dist:installer   # 或生成 NSIS 安装包（dist/DSH Desktop Setup *.exe）
```

> 注意：`npm run dist` 首次运行会复制约 255MB 的 DSH 运行时和 87MB 的 node.exe 到 `resources/`，并下载 Electron 发行版，耗时几分钟属正常。

## 分发给他人使用

打包产物**完全自包含**：接收方不需要安装 Node.js、不需要配置任何东西，x64 Windows 10/11 双击即可运行。

发送 `dist\DSH Desktop Setup 0.1.0.exe`（单文件安装包，约 200MB）即可；也可直接拷贝 `dist\win-unpacked` 整个文件夹。

接收方首次使用注意：

1. **SmartScreen 提示**：应用未购买商业代码签名证书，下载运行时会提示"Windows 已保护你的电脑"，点「更多信息 → 仍要运行」即可（首次安装后不再提示）。
2. **配置模型凭据**：应用不包含你的任何个人信息（会话、API 密钥都在各自电脑本地）。接收方需要在 GUI 的「设置」里配置自己的模型服务商凭据。
3. 每个接收方是独立的 DSH 环境：`DSH_HOME` 自动初始化，会话、设置互不影响。

## 工作原理

```
┌─────────────────────────────┐
│  DSH Desktop (Electron 窗口) │
│  1. 探测 3080~3103 端口      │
│     ├─ 已有 DSH GUI → 挂接    │
│     └─ 没有 → 自动拉起        │
│        node …/dsh/lib/bin.js │
│        web --port <空闲端口>  │
│  2. 健康检查（等页面就绪）     │
│  3. 打开原生窗口加载 GUI       │
│  4. 退出 → taskkill /T 清理   │
│     仅清理自己拉起的进程       │
└─────────────────────────────┘
```

- **端口策略**：从 `3080` 开始逐个探测；页面特征校验（`DeepSeek Harness` + `__DSH_BOOT__`）确认是 DSH 而非其他占用端口的服务。
- **第三方插件兜底**：若你的 `~/.dsh/profiles/web` 引用了内置运行时没有的插件（例如从其他 DSH 发行版带过来的 `@xxx/dsh-yyy`），应用会依次尝试：① 内置运行时 → ② 本机其他 DSH 安装（含该插件的那个）→ ③ 弹窗询问是否「忽略该插件并启动」（先备份 `package.json`，再移除缺失项后重试）。
- **日志**：`%APPDATA%\DSH Desktop\server.log`（服务器输出与启动记录）。
- **新窗口**：GUI 里打开的 `target=_blank` 链接一律转交系统默认浏览器。

## 环境变量（可选）

| 变量 | 作用 |
|---|---|
| `DSH_DESKTOP_DSH_PATH` | 手动指定 DSH 运行时（`@deepseek-ai/dsh` 包目录） |
| `DSH_DESKTOP_NODE` | 指定 node 可执行文件路径（默认用 PATH 中的 `node`） |
| `DSH_DESKTOP_FORCE_PORT` | 强制使用指定端口（跳过挂接探测，测试用） |
| `DSH_DESKTOP_USERDATA` | 重定向应用用户数据目录（测试用） |
| `DSH_HOME` | DSH 配置根目录（默认 `~/.dsh`，与 CLI 一致） |

## 依赖

- **打包产物（分发给他人）**：零依赖，仅需 x64 Windows 10/11。运行时使用内置的 node.exe（与 DSH 原生模块 ABI 严格一致），无需接收方安装任何东西。
- **开发/打包本应用**：需要 Node.js + npm（本机已具备）。

## 常见问题

- **端口被非 DSH 服务占用**：会继续往下一个端口探测；`3080~3103` 全占满时报错。
- **启动报 `cannot resolve profile bundle '@xxx/yyy'`**：你的 profile 引用了缺失的第三方插件（该包不在公共 npm 上时无法自动装回）。应用会自动尝试用本机其他含该插件的 DSH 安装启动；都没有时弹窗询问是否忽略该插件——选择忽略会先备份 `~/.dsh/profiles/web/package.json`（同目录 `.bak-<时间戳>`），再移除该项后继续启动。想恢复原插件时，把备份文件改回 `package.json` 并重新安装该插件即可。
- **找不到 DSH 运行时**：开发模式运行 `npm run bundle-dsh`，或设置 `DSH_DESKTOP_DSH_PATH`。
- **服务器意外退出**：窗口弹出提示，可一键重启（重新挂接或拉起）。
- **多个实例**：单实例锁，重复启动只会聚焦已有窗口。

## 目录结构

```
dsh-desktop/
├── main.js                # Electron 主进程（窗口、生命周期、服务器托管）
├── scripts/
│   ├── server.js          # 服务器核心逻辑（纯 Node，可独立测试）
│   ├── manual-test.js     # 纯 Node 冒烟测试（拉起/健康检查/清理）
│   ├── test-repair.js     # 缺失插件故障的复现与修复链路测试
│   ├── smoke-run.js       # Electron 冒烟测试运行器（截图验证）
│   ├── make-icon.js       # 生成应用图标（纯 Node，零依赖）
│   └── bundle-dsh.js      # 复制 DSH 运行时与 node.exe 进 resources/
├── resources/             # 图标 + 打包时内置的 DSH 运行时 (dsh/) 与 node.exe (node/)
└── dist/                  # 打包产物（win-unpacked/DSH Desktop.exe、Setup 安装包）
```

## 测试

```powershell
npm run manual-test   # 纯 Node：拉起服务器 → 健康检查 → 清理进程树 → 验证端口释放
npm run test-repair   # 纯 Node：构造"缺失第三方插件"故障 → 验证识别/备份/移除/重启全链路
npm run smoke         # Electron：挂接已有服务 → 截图 smoke.png
npm run smoke:spawn   # Electron：自拉服务器（端口 3999）→ 截图 smoke-spawn.png
```
