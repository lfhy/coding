# 改动连带影响

这张表回答"改了一处之后还必须做什么"。左列是改动的源头，中列是同一变更里必须一起做的动作，右列是会发现遗漏的检查。表里没有的检查说明该改动不需要它——不要为了保险跑全量门禁。

## 生成物

| 你改了 | 必须同时做 | 发现遗漏的检查 |
|---|---|---|
| `packages/*/*/src/**` 里的 `Context` 合并或事件声明 | `pnpm run gen-cordis-catalog`（重写子系统页的 `cordis-surface` 区域、`docs/cordis-api/*`、`packages/extensions/tool-cordis/src/api-catalog.ts`） | `packages/typert/generator/tests/cordis-catalog.spec.ts` 逐字节比对已提交产物 |
| `SessionEventMap` 的事件类型 | `pnpm run gen-persistence-catalog`（重写 `docs/persistence-catalog.md` 与 `packages/core/session/src/known-event-types.ts`） | `packages/core/session/tests/gen-persistence-catalog.spec.ts` |
| 插件的 `Config` 字段 | `pnpm run gen-config-catalog` | `packages/examples/agent-spine-demo/tests/gen-config-catalog.spec.ts` |
| 工具 schema、新增或删除工具包 | `pnpm run gen-tool-catalog`（会真实启动每个工具插件） | `packages/core/tools/tests/gen-tool-catalog.spec.ts` |
| 浏览器半的 `SlotMap` 声明或 `slots.register` 调用 | `pnpm run gen-client-catalog`（重写 `packages/extensions/cordis-client-runner/src/client/slot-catalog.ts`） | `scripts/gen-client-catalog.spec.ts` |
| `ctx.scope` 的事件路由 | `pnpm run gen-scoped-events`（重写 `packages/core/scope/src/scoped-events.generated.ts`） | `pnpm run verify-scoped-events` |
| 包之间的 `peerDependencies` | `pnpm run gen-module-graph` | `pnpm run verify-module-graph` |
| Cordis 配置行（`cordis*.yml`） | `pnpm run gen-code-map`（本目录的 `packages.md`、`wiring.md`） | `pnpm run gen-code-map --check` |

生成文件永不手工编辑：改生成器或源文档，再重跑生成命令，并把产物一起提交。

## 模型可见与持久化

| 你改了 | 必须同时做 | 发现遗漏的检查 |
|---|---|---|
| 模型可见文本（提示词、工具描述、结果渲染） | 更新对应的 keyless snapshot 或 `system-prompt.expected.md` | `pnpm run test:snapshot` |
| 新的模型可见输入 | 让它能从 session log 重建：新增事件或投影，而不是只加运行时状态 | session 与快照测试 |
| session 事件、配置格式或 wire 数据 | 在拥有它的包里维护版本与不变量；跨边界读取处做运行时校验 | 所属包的 `tests/` |
| `packages/*/*/src/**` 的公开导出 | 更新包 README 与 JSDoc；重塑已记录类型时同步 `docs/subsystems/` 的粘贴块 | `packages/core/agent/tests/verify-export-jsdoc.spec.ts` |
| 每个包新增 `./invariant` 检查 | 注册包名，或写明该包为什么没有可检查项 | `pnpm run verify-package-invariants` |

## 文档

| 你改了 | 必须同时做 | 发现遗漏的检查 |
|---|---|---|
| 包的行为、配置或限制 | 同一变更里更新该包 README（含 Model Experience 与 Known Limitations 两节） | 评审 |
| 文档路径或文件名 | 自己 grep 入站引用：链接目标、`#fragment` 锚点、代码注释里的 `docs/*.md` 路径 | 没有门禁兜底 |
| `docs/` 下被文档站发布的页面 | 确认 `website/docs.ts` 的 manifest 仍指向存在的源文件 | `pnpm docs:check` |

## 提交流程

1. 跑覆盖改动的最小检查集（上表右列 + 所属包的测试）。
2. `git diff --check`。
3. 提交前确认生成物已重跑、`docs/map/` 的两个生成文件没有过期（pre-commit 会自动重写它们）。
4. 单次提交只表达一个主题，不把无关改动带进来。
