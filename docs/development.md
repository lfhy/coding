# 开发指南

搭建教程引导新贡献者从准备前置条件开始，直到检出目录通过检查。后面的贡献者参考介绍仓库布局、日常工作流和 CI 组织方式。

## 搭建教程

### 前置条件

- Node.js 支持 `^22.19.0 || >=24.0.0`；个人客户端 CI 使用 Node 24。
- 启用了 Corepack 的 pnpm。仓库在 `package.json` 中固定使用 `pnpm@11.7.0`；如果 `pnpm --version` 无法通过 Corepack 解析，请先运行 `corepack enable`。
- Git 2.26 或更高版本；钩子设置会启用 Git 的 worktree 专属配置扩展。
- 可选：一个 DeepSeek API key，用于 Web、headless 和 ACP（Agent Client Protocol）自动化 agent（智能体）演示以及真实 API 的 e2e 测试。

### 首次搭建

在仓库根目录安装依赖：

```sh
pnpm install
```

安装过程还会通过 `scripts/install-lefthook.mjs` 配置 worktree 本地的 Lefthook 钩子。 负责钩子路径的安全约定。

如果依赖是从缓存恢复或 `postinstall` 被跳过而导致任一集成缺失，请手动安装：

```sh
node scripts/install-lefthook.mjs
```

移动检出目录后，请重新运行包装脚本以重新生成自有路径。

新克隆后请先运行一次类型检查：

```sh
pnpm run typecheck
```

`pnpm run typecheck` 成功退出即表示搭建完成。

## 贡献者参考

### TypeScript 项目布局

仓库使用相互隔离的 Host 与 Client aggregate。普通包只登记进其中一个 aggregate；Host 包进入 `tsconfig.host.json`，Client 包进入 `tsconfig.client.json`。

| 文件 | 角色 | 是否构成 program？ |
|---|---|---|
| `tsconfig.json` | solution 根：`extends` base、`files: []`、引用两个 aggregate。它是 tsserver 发现入口，也是显式执行整张 Project Reference 图时的入口；经继承的 `paths` 充当 tsx 运行 `examples/` 与 `scripts/` 时的解析配置。 | 否 |
| `tsconfig.host.json` | Host aggregate：Host 包、示例、测试、脚本，以及 `api/remotes` 的 Host 特例 project。 | 是 |
| `tsconfig.client.json` | Client aggregate：`packages/client/*` 包及其测试、`apps/web`，以及 `api/remotes` 的 Client 特例 project。 | 是 |
| `tsconfig.base.json` | 共享 compilerOptions 与源码 `paths` 映射。同时是各 vitest 配置让 vite-tsconfig-paths 指向的解析门面：它没有 `include`，因此其 `paths` 适用于任何 importer。 | 否 |
| `tsconfig.base.client.json` | 浏览器编译设置（`jsx`、DOM lib、`types: []`），由 Client aggregate 和每个 `packages/client/*` 包 extends。 | 否 |

Host 与 Client 保持两个 aggregate program，是因为两侧在相同键下以不同服务对 cordis `Context` 接口做声明合并；单一 program 同时看到两份合并会报冲突。这种冲突只存在于 `ts.Program` 内部——模块解析永远不会触发它——所以 solution 可以同时引用两个 aggregate，一个 paths 门面也可以横跨两侧。由此推出三条纪律：

- `tsconfig.base.json` 永不添加 `include` 或 `files`：它们会泄漏进每个 extends 它的包项目，并收窄门面的全匹配范围。
- 构造全仓 `ts.Program` 的脚本显式以 `tsconfig.host.json` 或 `tsconfig.client.json` 为种子——根 solution 永不作为种子，因为把两个 aggregate 展平进一个 program 会撞上 `Context` 合并冲突。
- 新包只登记进一个 aggregate。包同时具有 Node loader 入口和 browser 入口并不构成拆分理由；普通 Client 插件的两份运行时产物都在 Client 构建阶段生成。

`api/remotes` 是唯一拆分 Host/Client tsconfig 的仓库特例。它的 Host 入口必须进入 Host Typert 图，而 Client 入口导入 Host tsdown 才会生成的 `/remote` 声明，因此本包根 `tsconfig.json` 只作为 solution，两个 aggregate 和直接消费方分别引用 `tsconfig.host.json` 或 `tsconfig.client.json`。workspace `constraints` 门禁遍历可达的 Project Reference 图，并按各引用 project 自身的 compiler face 检查：只有单一配置的目标可由任一 face 引用，拆分配置的目标则必须引用匹配的 leaf，不得引用 solution 根或另一侧 leaf；该门禁按「两个 leaf 配置同时存在」自动发现拆分包，所以新拆分的包会自动纳入管辖。不要把该结构推广到其他包；[`api-remotes` README](../packages/api/remotes/README.md) 说明 Host/Client 拆分与构建顺序。

根构建按生成依赖排序：

```sh
tsc -b tsconfig.host.json
tsdown --env.DSH_BUILD_FACE host
tsc -b tsconfig.client.json
tsdown --env.DSH_BUILD_FACE client
pnpm run build:web
```

两次 tsdown 都使用同一组完整 workspace 匹配，不扫描构建产物来发现 Client 包，也不维护 Host/Client 包过滤表。包内 tsdown 配置根据 `DSH_BUILD_FACE` 决定当前阶段的入口：普通 Client 插件在 Client 阶段同时生成 Node loader 与 browser bundle；`api-remotes` 通过 `hostPhase: true` 提前生成 Host 入口，再在 Client 阶段只生成 browser bundle。tsdown 只消费 `lib/types` 中由前置 tsc 发射的 JavaScript。

Typert 只在 Host tsdown 中以 `tsconfig.host.json` 为种子运行。它分析 Host 类型并生成 Host 反射产物及 Host-for-Client Remote 投影；Client tsdown 不启动 Typert。`pnpm run typecheck` 因此先执行完整 Host lib 阶段，再运行 Client tsc；`pnpm run build` 继续执行 Client tsdown 和 Web 构建。该顺序的决策记录。

`pnpm run build` 会内联调用方精确的 `DSH_CLIENT_*` 环境；未设置时不使用任何公开 client 值。`pnpm run build:official` 仍供需要固定上游兼容 profile 的使用方调用；个人客户端 CI 使用普通的 `pnpm run build`。每次完整构建成功后都会写入一份被 gitignore 的记录，把这些值与 Vite 输出及动态 client bundle 绑定；built Web 测试会拒绝缺少记录或被后续局部构建改动的产物。

静态分析和测试通过 base 的 `paths` 映射把工作区 import 解析到 `src`，且必须在干净树上通过；消费构建产物 `lib/` 的门禁显式声明该依赖。生成的 Host-for-Client Remote 声明是有意设置的例外：公共 `typecheck` 和 `lint` 命令会先生成这些声明，而内部 `*:contracts-ready` 脚本假定调用它的公共命令或调度器门禁已经依赖 Typert 约定生成阶段或完整构建。两个 aggregate 的设置，tsc-first 发射职责，门禁准备约定。

业务服务在 Host 使用 `@Remote` 或 `@RemoteScope` 声明可调用方法；Host 构建生成 Host-for-Client 类型与运行时贡献，Client 的 `api-remotes` 组合加载这些贡献并挂到 `ctx.remote` 与作用域 `agentCtx.remote` namespace。两侧的生成产物、装配关系、SRC 开发回退和 Web 构建顺序见 [API Gateway](api-gateway.md)。

如果相关的本地检查需要使用构建后的包产物，请先构建一次：

```sh
pnpm run build
```

`pnpm run hygiene` 包含 `publint`（用构建出的 `lib/*.js` 文件校验包入口点）和 `verify-node-next-types`（用一个临时的 NodeNext 消费方校验构建出的声明文件）。新 worktree 在 `pnpm run build` 运行之前没有打包的 JS 和声明文件；普通提交和推送无需构建，除非所选检查会使用这些产物。

### 环境变量

真实的 DeepSeek 适配器和需要密钥的 agent 演示从环境变量或仓库根目录一个被 gitignore 的 `.env` 文件读取凭证：

```sh
DEEPSEEK_API_KEY=sk-...
DEEPSEEK_BASE_URL=https://... # optional
```

`DEEPSEEK_BASE_URL` 可选，默认为公开 API。请勿提交真实凭证。未设置 `DEEPSEEK_API_KEY` 时，真实 API 的 e2e 套件会自动跳过。

### Git 集成

lefthook 在 `lefthook.yml` 中配置，作为快速的本地检查点：

- `pre-commit` 使用不加载项目的 `.oxlintrc.staged.json` 配置验证暂存文件，并通过一次有界重试应用 Oxlint 修复，在暂存文件属于 `THIRD_PARTY_NOTICES.md` 的输入时重新生成该文件，然后检查暂存 diff 中的空白错误，并运行 vendor manifest（元数据清单）守卫；
- `pre-push` 运行 `pnpm run typecheck`；该命令会先完成包含 Typert 约定生成的完整 Host lib 阶段，再运行 Client TypeScript 检查。

vendor manifest 守卫检查 `vendor/*/src` 下的改动是否连同对应的 `vendor/README.md` manifest 更新一起暂存。请在编辑 vendor 代码前先阅读 `vendor/README.md`。

这些钩子有意不运行测试、快照、文档检查、构建或 `hygiene`。贡献者只运行一次[与改动行为相关的检查](../AGENTS.md)；发版 tag CI 会在 Node 24 上重复无凭据的 typecheck、lint、test 和 build 基线。

贡献者可以选择运行 `pnpm run check:all`，执行全面的本地门禁集。该命令独立于 Git 钩子，也不是对 agent 的指令。

### CI 门禁

无凭据的 [CI 工作流](../.github/workflows/ci.yml) 只会在推送 `v<version>` 发版 tag（例如 `v0.0.1`）时运行一个 GitHub-hosted Ubuntu job。它使用锁定依赖，在 Node 24 上验证该 tag 指向的源码，并执行 `pnpm run typecheck`、`pnpm run lint`、`pnpm run test` 和 `pnpm run build`。工作流不含凭据、上传、部署、真实提供方或桌面打包步骤；日常 push 和 Pull Request 依赖本地检查与 Git 钩子，只有明确的分发目标需要时才新增独立工作流。

### 日常命令

根目录的[贡献者说明](../AGENTS.md#commands)概述常用命令，[`package.json`](../package.json) 与 [scripts/run-gates.ts](../scripts/run-gates.ts) 则负责当前脚本和门禁清单。请选择覆盖变更表面的最小检查集。包公开行为变更还需更新所属 README 或 JSDoc，而基于构建产物的检查需要先运行 `pnpm run build`。

在 macOS 或已安装系统 WebView/CGO 依赖的 Linux 上测试原生桌面窗口，从仓库根目录执行 `make dev`；Windows 会在构建前报不支持。该命令先构建当前 Host、Client 和 Web 产物，再用 `apps/desktop/go.mod` 锁定的 Wails CLI 启动桌面壳，同时持续重建 Web 改动；Ctrl+C、终端挂断或开发窗口退出时会清理 Web watcher。开发实例使用独立窗口锁与 `~/.dsh-dev`，从当前仓库启动 Host，不占用已安装客户端的窗口和 `~/.dsh` 数据。需要验证 Remote-SSH 时另运行 `make remote-agent` 生成本地 agent 产物。

macOS arm64 上可运行 `pnpm run dev:electron` 验证[并存的 Electron 壳](../apps/desktop-electron/README.md)。先运行 `pnpm run build:remote-agent` 准备远端 agent 产物；开发命令构建 Host、Client、Web、Go helper 和 Electron 壳。单独的 `pnpm run build:electron-helper` 仅构建 Go helper，`pnpm run build:electron` 仅构建 Electron 壳。开发态使用独立的 `~/.dsh-electron-dev`；`make install` 与 `pnpm run build:desktop` 仍使用 Wails。开发态原生冒烟、回环 SSH fixture 和生产包分别验收，具体命令与限制见其 README。

### 演示

从源码 checkout 运行这些演示前，请单独执行仓库构建：

```sh
pnpm run build
```

单次运行的 Headless coding agent 需要环境变量或仓库根目录 `.env` 中的 `DEEPSEEK_API_KEY`：

```sh
pnpm dsh --profile headless "summarize this workspace"
```

自指的 cordis 演示可以检查并修改其实时插件运行时，并需要相同的凭证（默认 `web`，也可用 `acp`）：

```sh
pnpm run demo:cordis
```

ACP 自动化服务器通过 JSON-RPC stdio 提供全新 agent 会话，同样需要 `DEEPSEEK_API_KEY`：

```sh
pnpm run demo:acp
```

### TODO 标记

请使用以下三种注释标签之一标记代码中的已知问题，按紧急程度排序：

- `FIXME`：应当阻塞新版本发布的问题。除非评审者明确同意该更改可以合并，否则发布版本不应包含未解决的 `FIXME`；
- `TODO`：应当尽快修复的问题，等资源到位即可处理；
- `XXX`：也许某天会修复的问题，优先级最低，不作承诺。

请选择与紧急程度匹配的标签，让浏览代码的人一眼分清「发布阻塞」和「有空再说」。
