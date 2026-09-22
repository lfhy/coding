# 项目协作指南

本项目是基于 Cordis 的个人 AI 客户端，运行时能力以插件组成。修改 `packages/` 前先阅读 [架构说明](docs/architecture.md)；文档层级、中文单文档规则和预算遵循 [docs/AGENTS.md](docs/AGENTS.md)。项目当前同时建设 CLI 和桌面端，兼容性优先服务本项目的实际使用，不为上游发布流程保留约束。

## 项目概览

| 路径 | 用途 |
| --- | --- |
| `apps/cli/` | CLI 入口、参数解析、配置装配和进程生命周期；源码入口是 `apps/cli/src/bin.ts`。 |
| `apps/web/` | Client 端 Web/Vite 入口；桌面端将复用这里的界面和 Client bundle。 |
| `packages/core/` | 会话、提示词、工具、Agent 和 agent loop 等运行时基础能力。 |
| `packages/client/` | 浏览器与桌面端共享的 Client 插件、UI、远程调用和状态模型。 |
| `packages/api/`、`packages/typert/` | BFF/RPC 装配、类型图生成和运行时注册。 |
| `packages/llm/`、`packages/web/`、`packages/shell/`、`packages/fs/`、`packages/subprocess/` | LLM、网络、Shell、文件系统和进程能力；每项能力按 Service Definition、Provider、Consumer 组织。 |
| `packages/session/`、`packages/settings/`、`packages/credentials/` | 会话持久化、用户设置和凭据引用。 |
| `packages/experimental/` | 个人试验功能，不作为稳定客户端能力或发布接口。 |
| `vendor/` | Vendored Cordis 源码；修改前阅读 `vendor/README.md`，同步 manifest 和来源版本。 |
| `scripts/` | 构建、生成、质量检查和开发工具。 |
| `docs/` | 架构、开发、测试、用户指南和生成目录。 |

CLI 与桌面端共享 `packages/client/` 的业务模型和 UI，不在入口层复制会话、设置、凭据或 LLM 逻辑。桌面端新增原生能力时，先定义可测试的 Provider，再由 CLI、Web 或桌面壳作为 Consumer 使用；桌面壳的具体技术选型以单独的实现决策为准。

<a id="pre-release-stance-foundation-over-blast-radius"></a>

项目仍处于个人客户端早期阶段。可以在没有外部消费者时整体更新格式、命名和引用；形成可分发桌面安装包后，再为兼容性、迁移和回滚建立明确的产品规则。

<a id="commands"></a>

## 常用命令

```sh
pnpm install                 # 安装锁定依赖
pnpm run typecheck           # Host contracts + Client TypeScript
pnpm run lint                # Oxlint 静态检查
pnpm run test                # keyless Vitest 单元/集成测试
pnpm run build               # 构建 Host、Client 和 Web 产物
pnpm run build:official      # 使用固定客户端元数据构建可消费产物
pnpm run test:gui            # CLI/Host/Client GUI 相关测试
pnpm run check:all           # 需要完整本地门禁时使用
pnpm run hygiene             # 包约束、入口、依赖和产物卫生检查
pnpm run test:e2e            # 有 DEEPSEEK_API_KEY 时才运行真实 API 测试
```

先安装依赖再运行脚本；仓库使用 `package.json` 固定的 pnpm 版本和 Node 引擎范围。普通变更选择覆盖改动的最小检查集；跨包、公开行为、构建产物或用户可见输出的变更补充相应的构建、快照或文档检查。不要因为本地缺少外部凭据而把 keyless 检查改成静默跳过。

## CI 规则

`.github/workflows/ci.yml` 是当前唯一的 GitHub Actions 工作流，仅在推送 `v<version>` 发版 tag（例如 `v0.0.1`）后使用 `ubuntu-latest` 执行 `pnpm install --frozen-lockfile`、`typecheck`、`lint`、`test` 和 `build`。它只验证 tag 指向的源码，必须保持无凭据、无自托管 runner、无发布和无真实 API 调用；需要 API、桌面打包或发布时另建独立工作流，并将凭据限制在实际使用步骤。

CI 不代表桌面端所有平台已经支持。新增桌面壳或原生模块后，先在本机完成对应平台验证，再按稳定性和维护成本把平台构建加入单独的 opt-in 工作流。工作流使用 GitHub-hosted runner 的通用标签，不依赖组织专属 runner 名称、环境变量、项目 token 或上游仓库配置。

<a id="conventions"></a>

## TypeScript 与包边界

- Host 和 Client 是两个独立 aggregate；普通包只能登记到一个 aggregate。根 `tsconfig.json` 是 solution，不作为构造全仓 `ts.Program` 的种子。
- 源码检查通过 `tsconfig.base.json` 的 `paths` 解析到 `src`；只有明确消费构建结果的检查才读取 `lib/`、`dist/` 或打包目录。不要让本地陈旧产物改变测试结果。
- 每个能力完整包含 Service Definition、Provider 和 Consumer。注册是 effect：使用 `ctx.effect()`、`ctx.on()` 或注册器返回的 disposer 管理生命周期。
- 新的模型可见输入必须能从 session log 重建；新增模型可见行为时同步事件、投影、SDK 期望输出和 keyless snapshot。
- 跨进程、文件、网络、worker 和模型 JSON 边界进行运行时校验；同进程的静态类型边界信任 TypeScript，不为接口已保证的值增加重复 fallback。
- 跨边界 id 使用 `Branded` 类型；联合类型按 discriminant 分支，封闭联合以 `assertNever` 收尾。
- Waterfall listener 必须调用 `next()`；插件配置中的部署变量必须是经过校验的 `Config` 字段，不在插件中隐藏硬编码 tunable。

## 编码与文档

项目使用 ESM；包间引用使用包名，相对源码引用保留 `.ts` 后缀。公共导出和非显然的模块职责写简洁 JSDoc，函数类导出包含 `@param` 和 `@returns`。项目自有源码中新建或改动的 JSDoc、模块说明和非显然注释使用简体中文，说明调用者需要知道的行为、失败、所有权、时序或安全限制；不要逐行复述控制流、赋值或测试步骤。修改存量项目自有代码时，同步把改动区域内的英文注释改为中文；`vendor/`、内嵌第三方、生成代码、许可证、协议字面量和用户可见文本保持其已有语言。

每个包的公开配置、限制、扩展点和用户可见行为写在所属 README；类型、事件和生成目录写在对应文档层级。普通文档只维护无语言后缀的中文 `.md`，没有英文对侧文件、`.i18n.yaml` 记录或语言切换行；产品 UI、locale 字典和系统 i18n 不受此规则影响。完全由生成器写出的参考文档保持生成器自身的语言，改生成器或源文档后重新运行生成命令，不手工编辑生成文件。非机械的行为、架构、工具链或测试策略变更在同一变更中添加或更新 Agent Note，先检查是否有已实现记录需要归档或交叉引用。

## 凭据、数据与安全

本地真实 API 使用环境变量或根目录被 gitignore 的 `.env`，例如 `DEEPSEEK_API_KEY` 和可选的 `DEEPSEEK_BASE_URL`；绝不提交凭据、会话、设置、缓存或构建产物。配置文件、session log、worker 消息、工具 JSON 和 RPC 输入都视为外部数据，必须在所属解析点失败并给出具体诊断。不要为了测试方便放宽文件系统、Shell、网络或桌面权限。

SQLite schema、session format、配置文件和 wire/RPC 数据一旦被代码消费，就按拥有它的包维护版本与不变量。当前仍处于个人客户端早期阶段，可以在没有外部消费者时整体更新格式和引用；若将来形成可分发桌面安装包，再为迁移和回滚建立单独决策。

<a id="run-relevant-checks-locally"></a>

## Git 与 Agent 工作

单次改动聚焦一个主题，保留用户已有的未相关改动，不使用破坏性 reset 或 checkout。修改前先用 `rg` 查找现有实现、文档入口和测试；优先复用仓库已有依赖与抽象，不复制工具逻辑。可与功能实现解耦的文档编写或迁移优先委派为独立子任务，主任务只提供边界并验收结果。完成后运行与改动匹配的验证、`git diff --check`，并在交付说明中列出实际执行的命令和未执行的检查。仅修改 `AGENTS.md`、技能或普通说明时检查变更内容和 `git diff --check`，不运行 `lint`。只有修改代码、lint 配置、生成器或生成目录、网站投影时，才运行所属的 `lint` 或构建；不要因为无关输入存在而跑全量门禁，也不要并行执行会读写同一构建产物的重型命令。

新增功能、参数、默认行为、输出格式、配置项或桌面交互时，同步更新用户文档、README、测试和必要的 keyless snapshot。修改 `vendor/`、生成目录或快照时遵循各自的 AGENTS.md，不直接把生成文件当作源文件编辑。文件保持 ASCII 优先，并以恰好一个换行结尾。

除非用户明确要求不提交，任务完成并通过覆盖改动的验证后自动创建 Git commit。只暂存本任务相关文件，绝不使用 `git add .`、`git add -A` 或把用户已有的无关改动带入提交；提交说明使用简洁中文且只表达一个主题。因外部环境或已确认的无关时序问题无法完成某项检查时，提交前确保已运行足够的针对性验证，并在交付说明中列出未通过的命令和原因。

TODO 标记按紧急程度使用：`FIXME` 表示发布阻塞问题，`TODO` 表示近期修复，`XXX` 表示暂不承诺。不要把临时调试开关、个人路径、API key 或机器专属 runner 写进提交。
