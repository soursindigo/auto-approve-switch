# auto-approve-switch

一个 **DSH 本地插件**：拦截每一次即将执行的工具调用（`tools/pre-execute`），在"自动放行"开启时直接返回 `{ kind: 'allow' }` 跳过审批弹窗；用全局快捷键 **⌘⌥A / Ctrl+Alt+A** 随时开关，并在屏幕上弹出 Toast 提示。

> ⚠️ **安全声明（分享前请保留）**
> 开启后，本插件会跳过**所有**审批弹窗，**包括沙箱升级到 `danger-full-access`**——
> 也就是说模型可以在无人确认的情况下获得完全文件访问权限。每次自动批准都会写入
> `~/.dsh/auto-approve-switch.log`。请只在你信任模型与会话内容的前提下开启。

> 本插件基于 **DeepSeek Harness 0.2.1-rc.5**（`dshBuildCommit d4db512a`）随附的 API 编写，所有用到的接口都在该版本源码中逐一核对过（见 [API 核对](#api-核对)）。

---

## 1. 功能

| 需求 | 实现 | 位置 |
|---|---|---|
| 拦截所有工具调用，开启时 `{ kind: 'allow' }` | `ctx.on('tools/pre-execute', (exec, next) => …)` | `src/index.ts` → `apply()` |
| 全局布尔 `isAutoApproveEnabled`，默认 `true` | 模块级 `export let isAutoApproveEnabled = true` | `src/index.ts` |
| 全局快捷键 ⌘⌥A / Ctrl+Alt+A 切换 | `ctx.shortcuts.register({ … })` | `src/client.ts` |
| 切换时弹出提示 | `@deepseek-ai/dsh-client-ui-primitives` 的 `<Toast>` | `src/client.ts` → `showToast()` |
| 附加：侧边栏开关、跨窗口/重启同步 | `sidebar.footer.action` + `ctx.webServer` 路由 | 两半 |

### v0.5.1：自查修复与工程清理

自查时发现并修掉三处问题：

1. **快捷键可能双触发**：兜底键盘监听由 1.5s 定时器决定是否安装，而 `ctx.inject` 是异步的，
   服务在 1.6s 到达时会**同时存在**命令与兜底监听——按一次键翻转两次，看起来"没反应"。
   改为显式归属：谁先注册谁拥有触发权，另一方立即注销自己。
2. **侧边栏控件失败无提示**：HTTP 分支被明确拒绝时开关会静默回弹，现在会提示原因。
3. **诊断日志无限增长**：超过 256 KB 自动轮转并写入一行说明。

工程清理：删除未被引用的 `@deepseek-ai/dsh-package-manifest`、多余的 `scripts/probe-host.mjs`、
以及会**遮蔽真实类型**的 `src/shims.d.ts`（改为 `src/context.d.ts` 只增补 Cordis 运行时混入的
`on/inject/effect/get`，其余全部使用真实包类型）。新增 `.gitignore`。

### v0.5.0：侧边栏控件改用原生 Switch；去掉 emoji；修复静默消失

**现象**：重启后侧边栏底部**没有**开关（早期版本明明有），也看不到任何错误。

**原因**：v0.3.1 为了不让插件卡在 pending，把客户端 `inject` 从
`['slots','shortcuts','locale']` 改成了 `[]`。于是在 Cordis 上下文代理上读 `ctx.slots`
会抛错，而那段 `catch` 只 `console.warn`、**没进日志**——表现为"控件静默消失"。

**修复**：
- 服务改用**懒等待**：`ctx.inject(['slots'], scope => scope.slots.inject(...))`，
  既不阻塞激活，也不依赖未声明的服务（与官方 `dsh-session-purge` 客户端同款写法）。
- 侧边栏控件改用 shell 原生 `Switch`（`@deepseek-ai/dsh-client-ui-primitives`），
  与设置页里的开关完全一致；没有该组件时退回按钮。
- 删除了 Toast 文案与控件里的 🚀/🛑，控件状态改用**绿/红/灰圆点**。
- 修掉一个真 bug：`installKeyboardFallback(store)()` 会把刚装上的键盘监听**立刻移除**。
- 所有挂载结果（成功/失败）现在都写进插件日志，不再有"静默"路径。

### v0.4.0：补上真正拦得住审批弹窗的扩展点（重要）

v0.3.2 之后插件终于真正运行（`fiber.state = 2`、`stats.allowed` 随每次工具调用增长、HTTP 路由 200）。
但进一步核对源码发现一个**设计缺口**：

- `tools/pre-execute` 决定「这次调用是否被允许」，**它不负责弹窗**；
- 弹窗由**调用 `ctx.approval.request()` 的一方**产生。bash / fs 工具是在**自己的 body 里**、
  当本次调用要升级沙箱时才这样调用（`dsh-sandbox` 的 `approveEscalation`，`approver: ctx.get("approval")`）；
- `ApprovalService.decide` 走的是 **`approval/request` waterfall**，种子为 `'unavailable'`，
  应答者是返回结果的监听器。

所以只挂 `tools/pre-execute` 能跳过「策略审批」，却**跳不过用户真正看到的沙箱升级弹窗**。

**修复**：新增 `approval/request` 监听器——开启时返回 `'allowed-once'`（不再弹窗），
关闭时 `next()` 交还给人。每一次自动批准都会写入插件日志（含工具名与原因），因为
**自动批准“升级到 danger-full-access”是本插件安全上最敏感的行为，绝不静默**。

新增统计：`stats.approvals`（自动批准数）/ `stats.approvalsDeferred`（交还人类数）。

> ⚠️ 开启后，模型可以让一次操作升级到完全访问权限而**不再询问你**。
> 如果只想跳过普通审批、保留完全权限的确认，就把日志里出现的
> `escalate sandbox to danger-full-access` 作为告警看待，或按需修改本插件该监听器。

### v0.3.2：修复「应用能启动，但插件静默不工作」

v0.3.1 让应用能正常启动了，但插件依然没生效：日志只有 `module imported`、没有 `apply()`，
HTTP 路由仍 404，且**没有任何报错**。

**真实原因**：我导出了 `export const Config = { defaultEnabled: {...}, … }`。
Cordis 把插件的 `Config` 当作 Schemastery schema，调用 `Config.validate(rowConfig)`，
于是抛出 `TypeError: Cannot read properties of undefined (reading 'validate')`，
fiber 变成 **state 3 = FAILED**。而失败的非必需条目在启动审计里**只是一条 warning**，
所以应用照常启动、不崩溃，插件却什么都不做。

**修复**：
- **不再导出 `Config`**；行配置的形状改为 `RowConfig` 类型 + `apply` 内归一化。
- `apply()` 外层加诊断包裹：任何抛出都会先写进插件日志（`apply() FAILED: …` 带堆栈）再抛，
  这样下次不必再开终端。
- 新增"**按 Loader 方式挂载整个模块命名空间**"的真实 Cordis 测试，并断言 `'Config' in module === false`。

**至此三条真实链路均已用真实 Cordis 验证**（见 `tests/activation.test.mjs`）：
fiber `state === 2`（ACTIVE）、无未满足依赖、开关 ON 时 `{kind:'allow'}` 且审批生产者被跳过、
开关 OFF 时 `{kind:'ask'}` 且审批生产者被调用。

### v0.3.1：修复「启动即失败 / 软件损坏」

**现象**：重启后 macOS 弹出启动失败对话框（文案含"应用文件缺失或损坏，请重新安装"，
容易读成"软件损坏"），只能点"禁用第三方插件"才进得来。

**真实原因**（来自 `~/Library/Logs/DeepSeek Harness/crash-*-web-boot.log`）：

```
Error: web boot: 1 entry did not activate
auto-approve-switch: pending (waiting for service: optional)
```

Cordis 的 `Inject.resolve` 把注入声明当作**服务名表**：数组是名字列表，**对象的每个键也是名字**。
所以 `{ required: ['tools'], optional: [...] }` 实际声明了名为 `required` 和 `optional` 的服务——
它们永远不存在，fiber 永远停在 `pending`，`apply()` 从未执行。**这意味着 v0.1–v0.3 宿主端从未真正运行过**，
之前"自动放行生效"的观察并不可靠（很可能只是那些操作本来就不需要审批）。

**修复**：
- 两端 `inject` 均为**空数组**：宿主用 `ctx.on('tools/pre-execute')`（事件，不需要服务），
  可选服务一律经 `ctx.inject([...])` 惰性等待；客户端逐项降级（无 shortcuts→键盘兜底，无 slots→不挂侧边栏）。
- 新增 `tests/activation.test.mjs`：用**真实 Cordis 4.0.5** 挂载插件，断言 fiber 能激活、
  拦截器返回 `allow`、无服务时客户端仍能激活（Web boot 把"未激活条目"视为致命错误）。

### v0.2.0：修复「能开不能关」

**现象**：按第一次快捷键成功开启后，再按无法关闭，提示 `切换失败：Host 拒绝（Host 返回 405）`。

**根因（实测确认，不是推测）**：
1. 宿主端把状态通过 HTTP 路由提供给前端，但这些路由**并未被挂上**（我在本机用同一份代码复现是 200/200；
   而 `session-purge` 的真实路由返回 200、我的返回 404）。前端因此永远读不到真实状态。
2. 我的 405 处理器一定带 `allow:` 头，而实际响应**没有** —— 证明那不是我的代码回应的。

**修复**：
- **进程内直连**：Electron 桌面版里浏览器端与宿主端在同一个 JS 运行环境。宿主导出
  `globalThis.__DSH_AUTO_APPROVE_SWITCH__` 桥（get/set/toggle/subscribe），前端优先使用它，
  **完全不经过 HTTP**；纯 Web 宿主或远程页面看不到桥时自动回退到 HTTP。
- **乱序保护**：比当前更旧的 `revision` 响应不再覆盖新状态（这条也能单独导致“切不回去”）。
- **未知状态**不再被当成“开”去反推，而是明确按默认值处理。
- **启动日志**：宿主启动时向 stderr 打印
  `[auto-approve-switch] apply() v0.2.0 — ...` 与每条 `route mounted: ...`，
  重启后看一眼终端就能确认加载的是哪一版。

### v0.1.0 修复：「切换失败」的成因与对策

宿主对前端 REST 请求做了一层改写（实测：`/plugins/*` 的 GET 被改写成 404，`PUT` 会拿到 405），
所以浏览器**不能信任**一次写请求的 HTTP 结果。若沿用"等成功响应再改状态"，就会出现：

- 宿主其实已经切换了，但页面把响应看成失败 → **弹「切换失败」，状态却没变**（假失败）；
- 状态 GET 被拦 → 侧边栏显示「—」，连开关都以为是未知状态 → **点了没反应**。

现在的做法（「乐观 + 幂等 + 后台确认」）：

1. 按下快捷键**立刻**翻转显示并弹出正确 Toast，同时把**意图**写进 `localStorage`；
2. 用**幂等**的 `PUT /auto-approve-switch/state { enabled }` 提交（重复发送无害，不会像 `toggle` 那样翻回去）；
3. 后台按 300ms 频率读状态做确认；确认到就静默收敛，没确认到就**继续重试**，期间侧边栏显示"等待 Host 确认"；
4. 只有宿主**明确拒绝**（4xx，且不是 404）时才回滚并提示「切换失败：Host 拒绝」，并附上原因；
5. 页面刷新/重启后，未确认的意图会被恢复并继续确认。

因此：**正常情况下不应再出现「切换失败」**；它现在只代表"宿主明确拒绝"。

**提示文案**（开启 / 关闭）：

- `已开启自动放行`
- `已恢复手动审批`

**基础拦截逻辑**（`src/index.ts` 核心，节选）：

```ts
const offInterceptor = ctx.on('tools/pre-execute', (exec, next) => {
  if (!isAutoApproveEnabled) {
    // 关闭：不返回任何拦截结果，交还 DSH 原生流程
    return next()
  }
  // 开启：直接放行，跳过审批
  return { kind: 'allow' }
})
```

---

## 2. 项目结构

```
auto-approve-switch/
├── package.json            # 插件清单：dsh.bundle.patch + dsh.client（两部分入口）
├── cordis.patch.yml        # 把插件插入 profile 的 bundle patch
├── tsconfig.json           # 宿主端 TS 配置（输出 lib/index.js + index.d.ts）
├── README.md
├── src/
│   ├── index.ts            # 宿主端：pre-execute 拦截、全局状态、/status 与 /toggle 路由、可选持久化
│   ├── client.ts           # 浏览器端：快捷键注册、Toast、侧边栏开关、宿主状态轮询
│   └── shims.d.ts          # 仅类型声明（cordis / zod / storage-domain），不参与运行时
├── scripts/
│   └── build.mjs           # 用 esbuild 把 client.ts 打成 shell 需要的 factory 形式 CJS
├── tests/
│   ├── plugin.test.mjs     # 宿主端测试（模拟 cordis + 真实 HTTP 路由）
│   └── client.test.mjs     # 浏览器端测试（模拟 __ModuleLoader__ / React / primitives）
└── lib/                    # 构建产物（安装时由 dsh 直接加载）
    ├── index.js
    ├── index.d.ts
    └── client.js
```

---

## 3. package.json（完整）

```json
{
  "name": "auto-approve-switch",
  "version": "0.1.0",
  "private": true,
  "description": "DSH 本地插件：拦截 tools/pre-execute 自动放行工具调用，并用全局快捷键（⌘⌥A / Ctrl+Alt+A）随时开关。",
  "type": "module",
  "main": "lib/index.js",
  "exports": {
    ".": "./lib/index.js",
    "./client": "./lib/client.js",
    "./package.json": "./package.json",
    "./cordis.patch.yml": "./cordis.patch.yml"
  },
  "dsh": {
    "bundle": { "patch": "./cordis.patch.yml" },
    "client": { "platform": "web" }
  },
  "engines": {
    "node": "^22.19.0 || >=24.0.0",
    "dsh": ">=0.2.1-rc.0 <0.3.0"
  },
  "scripts": {
    "build": "node scripts/build.mjs client && tsc -p tsconfig.json",
    "build:client": "node scripts/build.mjs client",
    "build:host": "tsc -p tsconfig.json",
    "typecheck": "tsc -p tsconfig.json --noEmit && node scripts/build.mjs client --check",
    "test": "node --test tests/*.test.mjs",
    "check": "npm run build && npm run test"
  },
  "peerDependencies": { "@deepseek-ai/cordis": "~4.0.5" },
  "devDependencies": {
    "@deepseek-ai/dsh-package-manifest": "0.2.1-rc.5",
    "@deepseek-ai/dsh-storage-domain": "0.2.1-rc.5",
    "@types/node": "^24.0.0",
    "esbuild": "^0.25.0",
    "typescript": "^5.9.0",
    "zod": "4.4.3"
  },
  "files": ["lib", "cordis.patch.yml", "README.md"]
}
```

> 实际文件见仓库根目录（本 README 里的副本与之一致，仅排版不同）。

### 需要安装哪些依赖

```sh
npm install          # 仅开发/构建期依赖
npm run build        # 产出 lib/index.js、lib/index.d.ts、lib/client.js
```

- **运行期**：**零依赖**。`@deepseek-ai/cordis` 是 `peerDependency`（由 DSH 宿主提供）；`react`、`react-dom/client`、`@deepseek-ai/dsh-client-ui-primitives` 都是 shell 的**平台内置模块**（platform seed），无需也**不应**打包或安装。
- **TypeScript**：需要 `typescript`、`@types/node`、`esbuild`；`@deepseek-ai/dsh-package-manifest` / `dsh-storage-domain` / `zod` 仅用于类型与持久化（`zod` 固定为 4.4.3，与 `dsh-storage-domain` 的依赖版本一致）。

---

## 4. API 核对（为什么这些写法是真实有效的）

| 用到的 API | 证据（0.2.1-rc.5 随附源码） |
|---|---|
| `tools/pre-execute` 是 waterfall，返回值即决策 | `@deepseek-ai/dsh-tools` `lib/types/index.js`：`this.ctx.waterfall(carrier, 'tools/pre-execute', exec, () => ({ kind: 'allow' }))`，随后 `gate.kind === 'ask' ? serviceAsk(...)`。 |
| 决策词汇 `allow / deny / cancel / ask` | 同上 `prepareExecution()`；`ask` 才会走 `ctx.approval.request()` 弹窗。 |
| 与 `dsh-experimental-auto-review` 同款注册方式 | 官方 `auto-review` 插件正是 `ctx.on('tools/pre-execute', async (exec, next) => …)`。 |
| Cordis waterfall：返回值会截断后续链 | `@deepseek-ai/cordis` `lib/index.js` `waterfall()`：返回即短路由；只有调用 `next()` 才继续。 |
| 快捷键服务 | `@deepseek-ai/dsh-client-shortcuts` `register(command)`：`{ id, label, defaults: { 'desktop:macos': { code, modifiers } }, regions, modals, resolve }`。 |
| ⌘⌥A / Ctrl+Alt+A 合法且无冲突 | `bindingIssue()`：desktop 不限制；web 上"三修饰键"放行。内置命令中无 `KeyA + primary/alt`（仅 `session.archive` 使用 `primary+shift`）。 |
| Toast | `@deepseek-ai/dsh-client-ui-primitives` 导出 `Toast`，props 为 `{ text, icon?, tone?, anchor?, holdMs?, actions?, onDone }`，portal 到 `document.body`，`position: fixed; top: 40px`。 |
| 浏览器插件入口形态 | `dsh.client.platform: "web"` + `exports["./client"]`，bundle 需为 `window.__ModuleLoader__.load({ id, factory })` 的 factory 形式 CJS；`exports.apply/inject/name`。 |
| 客户端服务名 | 内置插件用 `const inject = ['slots', 'sessions', …, 'shortcuts']`（`dsh-client-ui-workspace`）。 |
| 宿主 HTTP 路由 | `@deepseek-ai/dsh-host-webserver`：`ctx.webServer.register({ kind: 'exact', path, handler })`，返回 disposer。 |
| 清单兼容性 | `evaluatePluginCompatibility()`：`engines.dsh`（优先）或 `peerDependencies` 的 `@deepseek-ai/dsh*` 必须满足；本插件在 0.2.1-rc.5 上判定为兼容。 |

### 几个容易踩坑的点（已在代码中处理）

1. **`ctx.effect` 返回的是"取消函数"，不是 disposer**：正确的清理写法是 `ctx.effect(() => () => { … })`，或保留 `ctx.on(...)` 返回的函数在清理时调用。
2. **Cordis waterfall 是"首个返回值即终局"**：本插件以**追加**（无 `prepend`）方式注册，因此在它之前注册的监听器（审批、deny 策略）仍然先生效；开启时它一旦返回 `allow`，其后的监听器不会再被问到——这正是"跳过审批"的含义。
3. **`crypto.randomUUID` 在 `http://127.0.0.1` 上不可用**（非安全上下文），代码中没有使用它。
4. **插件"开关"是进程级全局**：一个 Host 上所有会话/子代理共享同一个值。

---

## 5. 安装到 DSH

### 5.1 先构建

```sh
cd /path/to/auto-approve-switch
npm install
npm run build      # 或 npm run check：构建 + 全部测试
```

### 5.2 用官方 CLI 安装（推荐）

`dsh plugin` 是**透传 pnpm** 的命令，并会在安装后自动把声明了 `dsh.bundle` 的包加入 profile 的 `dsh.profile.bundles`：

```sh
# Desktop 版 DSH 使用保留 profile "desktop"（必须先开过一次 App，让它初始化 profile）
/Applications/DeepSeek\ Harness.app/Contents/Resources/runtime/cli/bin/dsh \
  plugin --profile desktop add /path/to/auto-approve-switch

# 如果你用 npm 全局安装的 dsh：
dsh plugin --profile <你的profile> add /path/to/auto-approve-switch
```

它会往 `~/.dsh/profiles/desktop/package.json` 写入：

```json
{
  "dependencies": { "auto-approve-switch": "file:../../agent/auto-approve-switch" },
  "dsh": { "profile": { "bundles": ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", "dsh-session-purge", "auto-approve-switch"] } }
}
```

然后**重启 DeepSeek Harness**（Host 进程需要重新组合插件树；客户端 bundle 也随重启一起发布）。

卸载：

```sh
dsh plugin --profile desktop remove auto-approve-switch
```

### 5.3 手动安装（不想用 CLI 时）

编辑 `~/.dsh/profiles/desktop/package.json`：把 `"auto-approve-switch": "file:/path/to/auto-approve-switch"` 加进 `dependencies`，把 `"auto-approve-switch"` 追加到 `dsh.profile.bundles`，然后在 `~/.dsh/profiles/desktop` 里执行 `pnpm install` 并重启 App。

### 5.4 临时/调试安装（不改 profile）

DSH 支持启动时追加一层 patch：

```sh
dsh --profile desktop --patch /path/to/auto-approve-switch/dev.patch.yml
```

其中 `dev.patch.yml` 为：

```yaml
- insert:
    - id: auto-approve-switch-dev
      name: 'file:///path/to/auto-approve-switch/lib/index.js'
```

> ⚠️ 这种方式只加载**宿主端**：浏览器端 bundle 需要该包出现在 profile 的 Loader 条目里才会被 `/plugins` 提供，因此快捷键/Toast 不会生效——日常请用 5.2。

### 5.5 行配置（可选）

在 profile 的 `cordis.patch.yml`（`~/.dsh/profiles/desktop/cordis.patch.yml`）追加，即可覆盖本插件行的配置：

```yaml
- id: auto-approve-switch
  config:
    defaultEnabled: true     # 启动时是否开启（默认 true）
    persist: true            # 是否跨重启记住状态（默认 true；需要 storageDomain）
    logDecisions: false      # 在 Host 日志逐条打印"已放行/交还原生审批"（排障时打开）
```

只想临时停用插件而不卸载：

```yaml
- id: auto-approve-switch
  disabled: true
```

---

## 6. 如何测试是否生效

### 6.1 单测（不启动 DSH）

```sh
npm run check
```

覆盖：默认开启时返回 `allow`；关闭时只 `next()` 不抢决策；上游 deny 被保留；开启时会话不再产生 `ask`；`/status` 与 `/toggle` 路由；跨源操作被拒（403）；错误方法被拒（405）；卸载时监听器与路由都被移除；以及浏览器端——快捷键注册参数正是 `{ code: 'KeyA', modifiers: ['primary','alt'] }`、按快捷键后 Toast 文案逐字正确、无快捷键服务时的键盘兜底、侧边栏控件。

### 6.2 手动验证清单（重启 App 后）

1. **宿主端加载**：打开 Host 日志/终端，应能看到
   ```
   [auto-approve-switch] 已加载 — 自动放行当前为 开启（快捷键 ⌘⌥A / Ctrl+Alt+A 切换）
   [auto-approve-switch] pre-execute 拦截已注册；状态接口 /auto-approve-switch/status
   ```
   并在 设置 → 插件 里看到名为 `auto-approve-switch` 的一行。
2. **接口探测**（端口换成 GUI 地址栏里的端口）：
   ```sh
   PORT=51418   # 换成你 GUI 地址栏里的端口
   # 幂等设定（推荐；脚本与修复后前端都用它）。Host 日志会同步打印一行状态：
   curl -s -X PUT -H 'content-type: application/json' -d '{"enabled":true}' \
        http://127.0.0.1:$PORT/auto-approve-switch/state
   # {"ok":true,"enabled":true,"revision":N,"source":"route","label":"已开启自动放行",...}

   # 翻转一次（保留给脚本；前端已不再用它，因为我们无法信任响应）：
   curl -s -X POST -H 'content-type: application/json' -d '{}' \
        http://127.0.0.1:$PORT/auto-approve-switch/toggle
   ```
   **探测技巧**：这个桌面宿主会改写 REST 响应，所以 `GET /status` 可能返回 404 而**不能证明插件没加载**。
   可靠的判据是 `PUT /state` 返回 `{"ok":true,...}` 而非 404/405，以及用 `logDecisions: true` 时
   Host 日志里出现 `▶ 已放行` / `↔ 交还原生审批`。
3. **快捷键 + Toast**：在 GUI 任意位置（输入框、终端里都行）按 **⌘⌥A**，应立刻在屏幕顶部中间看到 `已恢复手动审批`；再按一次出现 `已开启自动放行`。侧边栏底部的「自动放行」状态灯会同步由绿变红（灰=未知）。
4. **快捷键可在设置里改**：设置 → 快捷键 → 搜「自动放行」（命令 id `auto-approve-switch.toggle`），默认显示 ⌘⌥A。
5. **端到端行为**（重点）：
   - **关闭状态**：让模型执行一个需要确认的操作（例如 `bash` 中 `rm` 一个文件、或请求越界写入），应该照常出现审批弹窗——说明插件确实把决策交还给了 DSH。
   - **开启状态**：同样的操作不再弹出审批，直接执行；Host 日志里（若 `logDecisions: true`）会记录 `▶ 已放行：bash`。
   - 判据：`/auto-approve-switch/status` 返回值里的 `stats.allowed` / `stats.deferred` 计数会随调用增长，可直接证明拦截器在工作。

> 若按快捷键没有 Toast、但 Host 日志显示放行正常：多半是浏览器端 bundle 没有加载——检查 设置 → 插件 里该行是否有错误、以及是否真的**重启过** App（客户端 bundle 只在启动时组合）。

### 6.3 已知限制

- 只拦截 `tools/pre-execute` 这一**策略**层：**不**绕过文件沙箱、bash 沙箱、网络策略，也不影响 `tools.guard()`。
- 开启 = "永不问我"，不是"完全访问"；任何模型发起的命令都会直接执行，请自行评估风险。默认开启是按需求设定的，可用上面的 `defaultEnabled: false` 改掉。
- 状态是 Host 进程级全局；未启用 `storageDomain` 的 profile 不会跨重启记忆（已在状态里用 `source: "restored"` 区分）。

---

## 分享给他人 / 发布到 GitHub

本工程已经为分发准备好：`lib/` 已提交（他人用 git 安装时无需构建）、`private` 已移除、
MIT 许可证、`cordis.patch.yml` 使用**裸包名**（不含任何本机绝对路径）。

仓库地址已填好（`soursindigo/auto-approve-switch`）；若你 fork 到别处，
改 `package.json` 的 `homepage` / `repository` / `bugs` 即可。

### 方式一：GitHub 仓库（最简单）

```sh
git init && git add . && git commit -m "feat: auto-approve-switch plugin"
git remote add origin https://github.com/soursindigo/auto-approve-switch.git
git push -u origin main
```

他人安装：

```sh
dsh plugin --profile <profile> add https://github.com/soursindigo/auto-approve-switch
```

> 从 git 安装时 pnpm 可能拦截构建脚本。因为 `lib/` 已提交，**不需要构建**；
> 若提示 `allowBuilds`，直接忽略即可（本包没有需要执行的 postinstall）。

### 方式二：发布到 npm

```sh
npm login
npm publish --access public      # prepublishOnly 会自动构建 + 跑测试
```

他人安装：

```sh
dsh plugin --profile <profile> add auto-approve-switch
```

### 方式三：直接发压缩包

```sh
npm pack                        # 生成 auto-approve-switch-0.5.1.tgz
```

对方解压后：`dsh plugin --profile <profile> add /path/to/auto-approve-switch`

### 验证分发是否完整

```sh
npm pack --dry-run        # 应只含 lib/、cordis.patch.yml、package.json、README、LICENSE
npm run build && npm test # 40 项测试
```

