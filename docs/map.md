# 代码地图

改代码前先读这一页：它把“要改的东西在哪、谁拥有它、还要同步什么”集中到一处，避免每个任务重新搜索整个仓库。包数量及装配以生成清单为准，不在手写页保存易过期的计数。

## 读取顺序

| 文件 | 内容 | 什么时候读 |
|---|---|---|
| 本页 | 任务路由、常用命令 | 每个任务开始时 |
| [map/packages.md](map/packages.md) | 每个包的目录、职责、测试数、client/bundle 标记（**生成**） | 不知道某个能力在哪个包时 |
| [map/hot.md](map/hot.md) | 常改包的深度条目：拥有／不拥有、入口、接线、关键文件、连带改动、不变量（**手写**） | 改动落在这些包时，先读对应条目 |
| [map/wiring.md](map/wiring.md) | 每个 Cordis 配置的行 id → 插件包（**生成**） | 改装配、判断某个插件由哪一层挂载时 |
| [map/invariants.md](map/invariants.md) | 改一处必须同时改哪些生成物，以及谁在检查 | 改完准备提交前 |
| [architecture.md](architecture.md) | 组合方式、核心包、循环、能力 seam 的叙述地图 | 需要理解整体结构时 |

生成文件由 `pnpm run gen-code-map` 重写，pre-commit 也会自动重跑；不要手工编辑。

## 任务路由

| 我想… | 先读 | 通常要改 | 验证 |
|---|---|---|---|
| 加一个模型工具 | `map/packages.md` 的 `tool-*` 行、[tool-catalog.md](tool-catalog.md) | `packages/<group>/tool-<name>/`、`packages/bundle/*/cordis.patch.yml` 的行 | `pnpm exec vitest run packages/<group>/tool-<name>/tests` |
| 加或改客户端面板 | `map/hot.md` 的 client 条目、[packages/client/AGENTS.md](../packages/client/AGENTS.md) | `packages/client/ui-<name>/`、槽定义、bundle 的 `dsh.client` 行 | `pnpm exec vitest run packages/client/ui-<name>/tests` |
| 改浏览器启动或白屏 | [map/hot.md 的 Web 启动路线](map/hot.md#web-启动与渲染) | `apps/web`、`packages/client/web`、`modules`、`runtime`、`ui-renderer` | 相应包测试 + `DSH_SNAPSHOT=replay pnpm run test:web` |
| 改浏览器与 Host 的连接或 RPC | [map/hot.md 的连接路线](map/hot.md#浏览器与-host-传输) | `packages/client/connection`、`packages/api/remotes`、`packages/host/apiproxy`、`packages/host/webserver` | 相应连接/网关测试 + `DSH_SNAPSHOT=replay pnpm run test:web` |
| 改 Wails 桌面壳行为 | [map/hot.md 的桌面路线](map/hot.md#桌面壳与-host-启动) | `apps/desktop/`、共享 `desktopremote`/`hostlaunch`、打包脚本 | Go 测试 + 本机启动桌面端 |
| 改 Electron 桌面壳行为 | [map/hot.md 的桌面路线](map/hot.md#桌面壳与-host-启动) | `apps/desktop-electron/`、Go helper、共享 Host/Remote-SSH 契约、打包脚本 | 定向测试 + `pnpm run test:electron:smoke`；SSH 与生产包分别做 opt-in 原生验收 |
| 改工作区侧栏或目录选择 | [map/hot.md 的导航路线](map/hot.md#侧栏工作区与目录选择) | `ui-sidebar`、`ui-workspace`、目录选择 Client/Host 提供方 | 对应包测试 + `pnpm run test:gui` |
| 改设置和模型凭据界面 | [map/hot.md 的设置路线](map/hot.md#设置界面与凭据) | `ui-settings*`、settings/credentials 提供方或 `apiproxy` | 对应包测试 + `pnpm run test:gui` |
| 改输入、命令、工具卡片或轨迹 | [map/hot.md 的对话路线](map/hot.md#对话输入命令与视图) | `ui-conversation`、`ui-input-trigger`、`ui-commands`、`ui-tool`、`ui-trajectory` | 对应包测试 + 用户可见输出的 keyless 回放 |
| 改会话日志事件 | [subsystems/session.md](subsystems/session.md)、`map/invariants.md` | `packages/core/session/src/types.ts`、投影与快照 | `pnpm run gen-persistence-catalog` + session 测试 |
| 改插件装配 | `map/wiring.md` | `packages/bundle/*/cordis.patch.yml` | `dsh --profile web --dump-config` |
| 改插件可配置项 | [config-catalog.md](config-catalog.md)、包 README | 插件 `Config` 字段 + 包 README | `pnpm run gen-config-catalog` + 包测试 |
| 改模型可见文本 | 包 README 的 Model Experience 一节 | 提示词、工具 schema、结果渲染 | keyless snapshot（`pnpm run test:snapshot`） |
| 移植上游修复 | 对应包 README 与 `map/hot.md` 条目 | 受影响包；按本仓库约定改写，不保留上游发布流程约束 | 覆盖改动的测试 |
| 改文档或生成参考 | [docs/AGENTS.md](AGENTS.md) | 生成器或源文档 | `pnpm run gen-<name>`，再 `git diff` 看结果 |

## 常用命令

```sh
pnpm run typecheck # Host contracts + Client TypeScript
pnpm run lint # Oxlint
pnpm run test # keyless 单元/集成测试
pnpm exec vitest run <测试文件> # 单文件测试（首选，最快）
pnpm run gen-<name> # 重写某个生成产物；改完看 git diff
pnpm run build # Host、Client 与 Web 产物
pnpm run hygiene # 包约束、入口、依赖和产物卫生
pnpm run test:snapshot # keyless 快照比对
```

普通改动只跑覆盖改动的最小检查集：改包就跑那个包的测试，改装配再补一次启动冒烟，改模型可见输出才需要快照。全量门禁（`pnpm run check:all`）只在需要时使用，不要因为它存在就每次都跑。

## 读代码的默认路径

1. 先看包 README 的职责与限制，再看 `src/index.ts`：插件的 `name`／`inject`／`Config`／`apply`，或服务类的默认导出，就是它与外界的全部接口。
2. 找调用方用 `rg "<服务名>|<包名>" packages apps`，不要顺着目录猜。
3. `tests/` 与包同层，文件名就是行为名；想知道某行为怎么被固定，直接读对应的 `*.spec.ts`。
4. 生成产物（`docs/*catalog*.md`、`packages/**/*.generated.ts`、`api-catalog.ts`、`slot-catalog.ts`、`known-event-types.ts`）是只读事实源，改它们要改生成器。
