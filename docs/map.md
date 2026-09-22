# 代码地图

改代码前先读这一页：它把"要改的东西在哪、谁拥有它、还要同步什么"集中到一处，避免每个任务重新 grep 整个仓库。仓库有 228 个 workspace 包、约 25 万行 `src` 代码，没有地图时的探索成本远高于读这几页。

## 读取顺序

| 文件 | 内容 | 什么时候读 |
|---|---|---|
| 本页 | 任务路由、常用命令 | 每个任务开始时 |
| [map/packages.md](map/packages.md) | 228 个包各一行：目录、职责、测试数、client/bundle 标记（**生成**） | 不知道某个能力在哪个包时 |
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
| 改桌面壳行为 | `map/hot.md` 的 `apps/desktop` 条目 | `apps/desktop/` 的 Go 源码、`apps/internal/`、打包脚本 | Go 构建 + 本机启动桌面端 |
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
