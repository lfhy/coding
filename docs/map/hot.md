# 常改包条目

日常改动最常落在这些包上。每个条目回答四件事：**谁拥有它**、**它不拥有什么**、**改这里通常还要同步什么**、以及**最容易被违反的不变量**。路径与符号都经过核对；改到某个包时顺手更新它的条目，这是下一个 agent 少走弯路的地方。

包清单见 [packages.md](packages.md)（生成），装配关系见 [wiring.md](wiring.md)（生成）。下列跨包路线用于先确定文件范围；各包的配置、失败语义与扩展点仍以所属 README 为准。

## Web 启动与渲染

- **路线**：`apps/web/src/main.ts` 只取得 `#root` 并运行 `AppWebEntry`；`packages/client/web/src/boot.ts`/`src/platform.ts` 处理启动页、模块预载和 Loader 交接；`packages/client/modules/src/client/system.ts` 物化模块表；`packages/client/runtime/src/client/index.ts`/`slots.ts` 持有无 React 的会话、工作区和 slot 服务；`packages/client/ui-renderer/src/client/index.ts`/`app.tsx` 绑定 React 并挂载根 UI。
- **技术与边界**：浏览器 shell 使用 Vite，功能以动态 Cordis Client 插件装配；入口不复制状态或 JSX，业务对象在 runtime，React 订阅与 slot outlet 在 renderer。详细加载契约见 [client/web](../../packages/client/web/README.md)、[modules](../../packages/client/modules/README.md) 和 [ui-renderer](../../packages/client/ui-renderer/README.md)。
- **连带与验证**：改变动态模块或启动阶段时核对 `packages/bundle/web-app/cordis.patch.yml`、`packages/client/web/src/platform.ts` 与 browser loader 测试；改挂载/slot 时核对 `ui-renderer`、`runtime` 和消费方。定向运行 `pnpm exec vitest run packages/client/web/tests packages/client/modules/tests packages/client/ui-renderer/tests`；真实组装输出再跑 `DSH_SNAPSHOT=replay pnpm run test:web`。

## 浏览器与 Host 传输

- **路线**：`packages/client/connection/src/client/connection.ts` 管重连和双下行流，`src/client/web-api-client.ts` 发 `/api` 请求；Host 端 `packages/client/connection/src/index.ts`/`api-request-trust.ts` 管路由与信任栅栏，`packages/host/webserver/src/index.ts` 管 HTTP/upgrade 注册，`packages/host/apiproxy/src/api-proxy.ts` 管方法实现，`src/api/rpc.schema.ts` 管 wire 校验；`packages/api/remotes/src/client/index.ts` 是另一套 Typert Remote 入口，先于 API Proxy 认领自己的方法。
- **技术与边界**：浏览器 unary/respond 用 HTTP POST，下行 `events.mux`/`events.host` 用 WebSocket；webserver 不实现业务，apiproxy 不注册 HTTP 路由。信任规则和方法约定分别见 [connection](../../packages/client/connection/README.md)、[apiproxy](../../packages/host/apiproxy/README.md)、[remotes](../../packages/api/remotes/README.md)。
- **连带与验证**：协议变更同步 API schema、Client 调用、Host handler 与 keyless 回放；路由或升级变更同步信任拒绝测试，不能只验证回环成功路径。定向运行 `pnpm exec vitest run packages/client/connection/tests packages/host/apiproxy/tests packages/host/webserver/tests`，浏览器组装变化再跑 `DSH_SNAPSHOT=replay pnpm run test:web`。

## 桌面壳与 Host 启动

- **路线**：Electron 壳在 `apps/desktop-electron/src/main.ts`、`window.ts`、`native-chrome.ts`；Go helper `apps/desktop/cmd/electron-helper/main.go` 经 `apps/internal/hostlaunch/launcher.go` 启动 Host，并复用 `apps/desktop/internal/desktopremote/service.go` 与 `bridge.go`。helper stdio、远程连接 preload/main 授权分别在 `helper-client.ts`、`preload.ts`、`remote-ipc.ts`。
- **技术与边界**：`make dev` 启动 Electron 开发态，`make install` 安装由 `pnpm run build:desktop` 组装的 `dist/Coding.app`。Web UI、RPC 和会话由共享 Client/Host 包拥有；开发 home 独立，生产配置共享 `~/.dsh` 且先取得安装版单实例锁。壳与 Host 边界见[桌面原生验收](../desktop-shell-comparison.md)，运行限制见 [Electron README](../../apps/desktop-electron/README.md)。
- **连带与验证**：Host 就绪记录或所有权改动核对 `packages/bundle/web-app/src/managed-host.ts`、`apps/internal/hostlaunch` 与 Go helper；远程连接协议改动核对 `desktopremote`、`helperwire`、Electron IPC 和 Client 工作区。打包资源同步 `scripts/build-electron-helper.ts`、`scripts/package-electron-macos-app.ts` 与对应测试。开发态、SSH 和打包版分别做原生验证，命令见[应用条目](#appsdesktop-electron)。

## 远程连接模式与能力

- **路线**：`packages/client/ui-workspace/src/client/WorkspacePicker.tsx` 与 `remote.ts` 持有模式选择和桌面调用；Electron `remote-ipc.ts` 经 `apps/desktop/internal/desktopremote/service.go` 与 `bridge.go` 连接 `apps/desktop/internal/remoteagent/manager_ssh.go`。基础模式由 `direct_sftp.go`、`direct_search.go`、`direct_exec.go`、`direct_process.go`、`direct_terminal.go` 与 `direct_code.go` 提供，Agent 模式由远端 Go agent 提供。
- **能力边界**：`packages/subprocess/subprocess/src/remote-workspace.ts` 验证 marker、派生 target 并预检能力，bridge 再按活连接授权；`fs-local`、`subprocess-local`、Bash、搜索、LSP 与 Code Mode 的 Provider 在操作入口遵守模式。基础模式支持远端文件读写编辑、前后台命令、PTY、搜索及带远端 binding 的本机隔离 Code Mode，LSP 不可用；任一远端能力失败都不可转到本机工作区或 Host 进程。具体限制见[用户指南](../user/guide/index.md#选择开始方式)及所属包 README。
- **连带与验证**：模式字段或 bridge 路由变化时同步 Electron 壳、`ui-workspace`、`subprocess` 类型与[子系统页](../subsystems/subprocess.md#可执行文件查找)、相关能力包 README 与定向测试；原生 SSH fixture 和打包版验证分开运行，不把开发态覆盖等同于生产包或真实服务器验收。

## 侧栏工作区与目录选择

- **路线**：`packages/client/ui-sidebar/src/client/index.ts` 声明侧栏座位；`packages/client/ui-workspace/src/client/index.ts` 占用 `sidebar.workspaces` 与 `conversation.hero.workspace` 并声明两个 `directoryFlow` 子座位；浏览器目录流程由 `packages/client/ui-directory-picker-browse/src/client/index.ts`/`flow.ts` 占用，Host 能力由 `packages/host/directory-picker-*` 提供。Session/Workspace 状态的业务所有者是 `packages/client/runtime`，不是侧栏组件。
- **技术与边界**：UI 依 slot 声明生命周期注册；目录后端是 browse、native 或 auto 的可替换 Provider，不能在组件内按平台自行选择。目录能力契约见 [ui-workspace](../../packages/client/ui-workspace/README.md) 与 [Host directory-picker](../../packages/host/directory-picker/README.md)。
- **连带与验证**：调整座位同步 `ui-sidebar`、`ui-workspace/src/client/contract/slots.ts`、目录占用插件与组合行；目录协议变更同步 Host Provider 和 Client flow。定向运行 `pnpm exec vitest run packages/client/ui-sidebar/tests packages/client/ui-workspace/tests packages/client/ui-directory-picker-browse/tests`，组装交互再跑 `pnpm run test:gui`。

## 设置界面与凭据

- **路线**：`packages/client/ui-settings/src/client/index.ts`/`settings-mirror.ts` 持有唯一的 `settings.describe` 镜像与设置 slot；`packages/client/ui-settings-general/src/client/SettingsRoot.tsx` 持有外壳；`packages/client/ui-settings-models/src/client/ModelsSection.tsx`/`ProviderEditor.tsx` 持有模型页。Host 协议在 `packages/host/apiproxy/src/api/settings.schema.ts`/`credentials.schema.ts`，持久设置和机密分别由 `packages/settings/settings-*` 与 `packages/credentials/credentials-*` 管。
- **技术与边界**：各 UI 行从共享镜像派生作用域，机密配置只传引用，真实值归 Credentials Provider；详见 [ui-settings](../../packages/client/ui-settings/README.md)、[ui-settings-models](../../packages/client/ui-settings-models/README.md) 及所属 Provider README。
- **连带与验证**：新 namespace 同步 schema、Host RPC、设置卡片和包 README；凭据字段不能只改表单，需验证来源及遮蔽拒绝。定向运行 `pnpm exec vitest run packages/client/ui-settings/tests packages/client/ui-settings-general/tests packages/client/ui-settings-models/tests packages/host/apiproxy/tests/api-proxy-config.spec.ts`，可见界面再跑 `pnpm run test:gui`。

## 对话输入命令与视图

- **路线**：`packages/client/ui-conversation/src/client/apply.ts` 声明对话座位，`input/hub.ts` 与 `skeleton/InputBar.tsx` 管每会话输入；`packages/client/ui-input-trigger/src/client/controller.ts` 管内联触发，`packages/client/ui-commands/src/client/service.ts` 管命令目录与弹层；`packages/client/ui-tool/src/client/apply.ts` 注册工具行，`packages/client/ui-trajectory/src/client/index.ts` 注册轨迹视图。
- **技术与边界**：输入和视图通过 slot/领域注册表组合，持久事件仍由 Session/Host 拥有；工具卡片、轨迹、命令 UI 不往 runtime 增加中央事件 switch。参见 [ui-conversation](../../packages/client/ui-conversation/README.md)、[ui-commands](../../packages/client/ui-commands/README.md) 与 [ui-trajectory](../../packages/client/ui-trajectory/README.md)。
- **连带与验证**：改变输入提交要核对 `packages/client/runtime` 的 Session 与 Host RPC；改变持久 Chat 行须更新 `ConversationNodeDefinition` 和 keyed renderer；改模型可见内容还要核对 session 事件与 snapshot。定向运行 `pnpm exec vitest run packages/client/ui-conversation/tests packages/client/ui-commands/tests packages/client/ui-input-trigger/tests packages/client/ui-tool/tests packages/client/ui-trajectory/tests`，可见输出再跑 keyless `DSH_SNAPSHOT=replay pnpm run test:web`。

## packages/core/agent

- **拥有**：`Agent` handle 接口、活跃 agent 注册表 `AgentRegistry`（ctx 键 `agents`）、进程内 initiator 作用域（`withInitiator`/`requireInitiator`）、`agent/*` 实时事件词汇，以及经 `setFactory` 暴露的 `create`/`resume` 创建 API。
- **不拥有**：具体驱动器与创建事务（`packages/core/agent-loop`）；持久会话日志与 `SessionHeader`（`packages/core/session`）；subagent 委派传输（`packages/subagent/subagent-in-process-driver` 经工厂 API 消费）。
- **入口**：`packages/core/agent/src/index.ts`（默认导出 `AgentRegistry`；声明 `ctx.agents`、`ctx.agent` accessor 与 typert `agent` lookup）。
- **接线**：`packages/bundle/base/cordis.patch.yml` 的 `agent` 行；消费方 `packages/host/apiproxy/src/api-proxy.ts`、`packages/subagent/subagent-in-process-driver/src/index.ts`。
- **关键文件**：`packages/core/agent/src/index.ts`、`packages/core/agent/src/runtime-types.ts`、`packages/core/agent/src/dispatch.ts`。
- **改这里要同步**：`packages/core/agent-loop/src/agent.ts`（接口实现方）、`docs/subsystems/core.md` 的生成区块（`pnpm run gen-cordis-catalog`）、包 README。
- **不变量**：`enter` 强制 `agent.id === agent.session.id`，并发 prepare 只有一个能 enter；`agent/created` 与 `agent/disposed` 必须成对，创建分发期间请求的 detach 延后到分发退栈。
- **测试**：`pnpm exec vitest run packages/core/agent/tests`

## packages/core/agent-loop

- **拥有**：唯一具体驱动器 `ReactLoopAgent` 与 `AgentLoop` 服务（ctx 键 `agentLoop`），实现 `AgentFactory` 并在构造时 `ctx.agents.setFactory(this)`；创建/恢复的回滚事务、有序 teardown、配置驱动 agent 启动与 `agent-loop/config-start-failed`。
- **不拥有**：`Agent` 接口与注册表（`packages/core/agent`）；会话日志与派生历史（`packages/core/session`）；模型流式 seam（`packages/llm/llm`）；钩子、压缩、沙箱、subagent 等扩展行为（都是监听事件的插件）。
- **入口**：`packages/core/agent-loop/src/index.ts`（默认导出 `AgentLoop`，`static inject = ['agents','sessions','llm','tools','systemPrompt']`；Config 为 `maxParallelToolCalls` + `agents[]`）。
- **接线**：`packages/bundle/base/cordis.patch.yml` 的 `agent-loop` 行（`agents: []`，由上层 overlay 填充）；消费方 `packages/host/apiproxy/src/api-proxy.ts`、`packages/experimental/agent-team`。
- **关键文件**：`packages/core/agent-loop/src/index.ts`、`packages/core/agent-loop/src/agent.ts`、`packages/core/agent-loop/src/tool-calls.ts`。
- **改这里要同步**：`docs/subsystems/core.md` 的生成区块、`docs/architecture.md` 的轮次流程、`packages/core/agent-loop/tests/` 下以行为命名的 spec。
- **不变量**：每个成功 provider 调用恰好追加一个 `assistant/message` 完成锚点（含无内容与 max-tokens 调用）；teardown 顺序固定为停机排空 → `scope.dispose` → detach agent → detach session；setup 只组合不驱动。
- **测试**：`pnpm exec vitest run packages/core/agent-loop/tests`

## packages/core/session

- **拥有**：仅追加的 `SessionEvent` 日志、内存存储 `SessionStore`（ctx 键 `sessions`）、`Session`（`append`/`deriveMessages`/`surface`/`firstLiveSeq`）、`SessionEventMap` 与 `SessionHeader` 类型所有权、surface 投影、请求头重建。
- **不拥有**：持久化（Service Definition 在 `packages/session/session-persistence`，后端在同级包）；事件目录是生成文档（`scripts/gen-persistence-catalog.ts`），不手工编辑。
- **入口**：`packages/core/session/src/index.ts`（默认导出 `SessionStore`；声明 `ctx.sessions` 与 `session/created|disposed|event|flush`）。
- **接线**：`packages/bundle/base/cordis.patch.yml` 的 `session` 行；被 `packages/core/agent-loop/src/index.ts`、`packages/session/session-persistence-jsonl/src/index.ts`、`packages/core/tools/src/index.ts` 消费。
- **关键文件**：`packages/core/session/src/index.ts`、`packages/core/session/src/surface.ts`、`packages/core/session/src/types.ts`。
- **改这里要同步**：`packages/core/session/src/known-event-types.ts` 与 `docs/persistence-catalog.md`（`pnpm run gen-persistence-catalog`）、各持久化后端、`packages/core/agent-loop`（派生历史的头号消费方）。
- **不变量**：`seq = log.length` 全程连续；模型可见即已记录——新增模型可见输入必须扩展 `SessionEventMap` 并能从日志渲染；derived cache 随 surface `replace` 整体重建，没有原始日志回退。
- **测试**：`pnpm exec vitest run packages/core/session/tests`

## packages/core/tools

- **拥有**：`ToolRuntime`（ctx 键 `tools`）注册表与作用域遮蔽（`presentAs`/`restrict`）、呈现模式（Config `mode: native|code|both`）、执行流水线 `tools/pre-execute` → guard → `tools/execute` → `tools/post-execute` → `finalizeContent` → `tools/result`、`defineTool` 与 JSON Schema 校验、code-mode 的 `run_code` 传输。
- **不拥有**：具体工具实现（各 `tool-*` 插件）；审批 seam（`packages/interaction/user-approval`，经 `ctx.get('approval')` 可选）；code runtime 执行（`packages/code-runtime/*`）；持久 `tool/result` 会话事件（由 agent-loop 追加）。
- **入口**：`packages/core/tools/src/index.ts`（默认导出 `ToolRuntime`，`static inject = ['systemPrompt']`）。
- **接线**：`packages/bundle/base/cordis.patch.yml` 的 `tools` 行；消费方 `packages/core/agent-loop/src/tool-calls.ts` 与全部 `tool-*` 插件。
- **关键文件**：`packages/core/tools/src/index.ts`、`packages/core/tools/src/schema.ts`、`packages/core/tools/src/code-mode.ts`。
- **改这里要同步**：`docs/tool-catalog.md`（`pnpm run gen-tool-catalog`）、`docs/tool-execution-pipeline.md`、`docs/subsystems/tools.md` 的生成区块。
- **不变量**：waterfall 监听器必须调用 `next`；guard 拒绝是单调终局，后续 waterfall 不能翻案；保留名 `run_code` 不能被注册、遮蔽或移除。
- **测试**：`pnpm exec vitest run packages/core/tools/tests`

## packages/core/scope

- **拥有**：作用域注册原语库（无 ctx 键、非服务）：`createScope`/`scopeOf`/`scopeTarget`/`bindScopeParent`/`scopeChainOf`/`isScopeCarrier` 与 `Scoped<T>` brand；共享分层存储 `ScopeLayer`/`ScopedLayers`；可选 `./invariant` 配套入口。
- **不拥有**：任何具体作用域语义——agent 作用域的创建在 `packages/core/agent-loop/src/agent.ts`，各服务的 scoped 表层由 `packages/core/tools`、`packages/core/system-prompt`、`packages/core/session` 各自实现。它明确不是权限或沙箱边界。
- **入口**：`packages/core/scope/src/index.ts`（纯库导出，无默认导出、不注册 ctx 键）。
- **接线**：不在任何 `cordis.patch.yml` 中装配，作为 workspace 依赖被 `packages/core/agent`、`packages/core/session`、`packages/core/tools`、`packages/core/system-prompt` 直接导入。
- **关键文件**：`packages/core/scope/src/index.ts`、`packages/core/scope/src/store.ts`、`packages/core/scope/src/invariant.ts`。
- **改这里要同步**：`packages/core/scope/src/scoped-events.generated.ts`（`pnpm run gen-scoped-events`）、全部实现 `ScopeLayer` 或使用 `scopeTarget` 的包。
- **不变量**：带作用域的事件分发必须携带 `scopeTarget` 构造的载体，且载体键与 payload 主体严格相等；父链只绑定一次、rebind 仅经返回的句柄、拒绝闭环；注册视图沿链向下继承，事件放行沿链向上扩展，反向永不成立。
- **测试**：`pnpm exec vitest run packages/core/scope/tests`

## packages/llm/llm-deepseek

- **拥有**：`deepseek-official` 路由的 `DeepSeekAdapter`（直接 fetch + SSE、wire ↔ `StreamChunk`）、每请求动态解析的连接与凭据事实（settings 分节 + `ctx.credentials`）、catalog 与推理强度默认值、图片处理与 `LlmError` 错误码映射。它是 `packages/llm/llm` seam 的 Provider。
- **不拥有**：`LlmRuntime`/`ctx.llm` 与 `StreamChunk` 词汇（`packages/llm/llm`）；重试执行（`packages/llm/llm-retry`）；pi-ai 的 `deepseek` 路由（`packages/llm/llm-pi-ai`，同一 seam 的另一个 Provider）。
- **入口**：`packages/llm/llm-deepseek/src/index.ts`（函数插件：`name`/`inject = ['llm']`/`Config`/`apply`）。
- **接线**：`packages/bundle/base/cordis.patch.yml` 的 `llm-deepseek` 行；`apply` 内 `ctx.llm.registerAdapter([PROVIDER], adapter)`。
- **关键文件**：`packages/llm/llm-deepseek/src/index.ts`、`packages/llm/llm-deepseek/src/adapter.ts`、`packages/llm/llm-deepseek/src/sse.ts`。
- **改这里要同步**：包 README、`docs/config-catalog.md`（`pnpm run gen-config-catalog`）、`tests/adapter.spec.ts` 与 `tests/mock-server.ts`。
- **不变量**：连接与凭据事实是同一份解析快照，被拒的 settings 世代整体不生效（旧 endpoint 绝不配新 key）；唯一注册期事实是 retryPolicy，变化时原地 `registration.replace([PROVIDER])`；重复注册同一 provider 抛 `LlmError('DUPLICATE_ADAPTER')`。
- **测试**：`pnpm exec vitest run packages/llm/llm-deepseek/tests`

## packages/session/session-persistence-jsonl

- **拥有**：JSONL 物理存储后端：每会话一个仅追加 `.jsonl.zstd`（或 `.jsonl`）文件、项目/会话目录布局与 id 转义、Zstandard frame 编解码、撕裂尾部截断修复、Windows 原子发布。它是 session-persistence seam 的 Provider。
- **不拥有**：`SessionHeader`/`SessionEvent` 类型（`packages/core/session`）；写协调、批处理窗口、恢复与接管生命周期（`packages/session/session-persistence`）；SQLite 后端（`packages/session/session-persistence-sqlite`）。
- **入口**：`packages/session/session-persistence-jsonl/src/index.ts`（默认导出 `JsonlSessionPersistence`，`static inject = ['sessions']`；Config 的 `root` 必填无默认）。
- **接线**：`packages/bundle/base/cordis.patch.yml` 的 `session-persistence-jsonl` 行；消费方是 `packages/core/agent-loop/src/index.ts` 的 resume 路径与 `packages/host/apiproxy`。
- **关键文件**：`packages/session/session-persistence-jsonl/src/index.ts`、`packages/session/session-persistence-jsonl/src/format.ts`、`packages/session/session-persistence-jsonl/src/zstd.ts`。
- **改这里要同步**：`packages/session/session-persistence/src/coordinator.ts`（共享生命周期约定）、`packages/core/session/src/chunk-rows.ts`、包 README 与 `tests/zstd.compat.spec.ts`。
- **不变量**：仅追加——已 flush 事件绝不重写，`append` 首 seq 必须等于已存储的 next-seq；一个 root 只属于一种编码，相反 suffix 与平铺布局直接拒绝；header id 必须等于请求 id。
- **测试**：`pnpm exec vitest run packages/session/session-persistence-jsonl/tests`

## packages/bundle/web-app

- **拥有**：浏览器表层的组合包：`cordis.patch.yml`（叠加在 dsh-base 之上的 host 行覆盖/禁用 + `dsh.client` 浏览器插件名录）与 `web-runtime` 粘合插件（解析已构建前端 dist、`webRuntime` 服务、URL 打印与浏览器交接、`DSH_WEB_URL`）。
- **不拥有**：基础行（persona 基线、tools、session 层）由 `packages/bundle/base` 拥有，本包只覆盖或禁用；前端 dist 构建属于 `apps/web`；headless 表层属于 `packages/bundle/headless`。
- **入口**：`packages/bundle/web-app/src/index.ts`（`name = 'web-app'`，提供 `webRuntime`）；`packages/bundle/web-app/src/startup.ts`（解析 `--host/--port/--trusted-host/--no-open`）。
- **接线**：`apps/cli/src/profile-boot.ts` 按 `dsh.profile.bundles` 顺序叠加本包 patch；`dsh web` 别名在 `apps/cli/src/args.ts`。
- **关键文件**：`packages/bundle/web-app/cordis.patch.yml`、`packages/bundle/web-app/src/index.ts`、`packages/bundle/web-app/src/managed-host.ts`。
- **改这里要同步**：新增 client 插件要同时改三处——`tsconfig.client.json` 的 references、`cordis.patch.yml` 的 `dsh.client` 行、`packages/bundle/web-app/package.json` 的依赖；改装配后 `pnpm run gen-code-map`。
- **不变量**：patch 行整体替换目标行的 `config`，每行必须重述自己拥有的全部键；Web 表层把 agent 面行（`tool-bash`/`tool-fs`/`tool-subagent` 等）显式 `disabled: true` 而不是删除，防止 base 重排时静默复现。
- **测试**：`pnpm exec vitest run packages/bundle/web-app/tests`

## packages/extensions/cordis-client-runner

- **拥有**：动态双半插件包的浏览器半：把定义源码变成活的浏览器插件（`evaluateClientHalf` → guard 门面 → 模块表 → loader entry）、run 编排（`CordisRunOrchestrator`），以及 `ctx.dynamicCordisRunner`（`CordisRunnerFace`）。
- **不拥有**：host 半（定义留存、request-run 事件、guard 白名单正本）属于 `packages/extensions/cordis-host-runner`；wire 契约属于 `packages/api/remotes`；运行面板 UI 属于 `packages/extensions/ui-cordis`。
- **入口**：`packages/extensions/cordis-client-runner/src/client/index.ts`（`inject` 含 `remote.dynamicCordisRunner`）；node 半 `src/index.ts` 是空 apply，只让行出现在 host Loader。
- **接线**：`packages/bundle/web-app/cordis.patch.yml` 的 `cordis-client-runner` 行。
- **关键文件**：`packages/extensions/cordis-client-runner/src/client/runtime.ts`、`packages/extensions/cordis-client-runner/src/client/guard.ts`、`packages/extensions/cordis-client-runner/src/client/orchestrator.ts`。
- **改这里要同步**：guard 白名单是 `packages/extensions/cordis-host-runner/src/guard.ts` 的手抄孪生，两边必须同时改；wire 字段改动走 `packages/api/remotes`；`src/client/slot-catalog.ts` 与 `api-catalog.ts` 是生成物。
- **不变量**：激活时什么都不装，只有一页回答过一次 run 请求或用户主动发起才装载；渲染期失败通道纯事后诊断，绝不触碰 run 的最终回答，`renderFailures` 是页面本地事实。
- **测试**：`pnpm exec vitest run packages/extensions/cordis-client-runner/tests`

## packages/client/ui-layout

- **拥有**：浏览器根布局壳：唯一的 `root` entry（`AppFrame`）声明 `sidebar`/`conversation`/`details`/`workbench`/`workbench.bottom`/`shell.overlay` 子 slot、按 Session 隔离的布局 store、`ctx.layout`（`openWorkbench(sessionId)` 等），以及把 `ctx.theme` 快照投影到 DOM 的 `ThemePresenter`。
- **不拥有**：主题偏好与快照（`packages/client/ui-theme`），本包只做 DOM 呈现；工作台内容（文件树/预览/终端）属于 `packages/client/ui-open-in-app`；`conversation` 座位的占用者是 `packages/client/ui-conversation`。
- **入口**：`packages/client/ui-layout/src/client/index.ts`（`ctx.slots.register({ name: 'root', children, store: createLayoutStore, inject }, AppFrame)` 并 `ctx.reflect.provide('layout', layout)`）；node 半是空 apply。
- **接线**：`packages/bundle/web-app/cordis.patch.yml` 的 `ui-layout` 行；`'root'` slot 本体由 `packages/client/runtime/src/client/slots.ts` 预置，禁止第二者注册 root。
- **关键文件**：`packages/client/ui-layout/src/client/index.ts`、`packages/client/ui-layout/src/client/AppFrame.tsx`、`packages/client/ui-layout/src/client/service.ts`、`packages/client/ui-layout/src/client/stores.ts`。
- **改这里要同步**：新增或改座位要同步 `SlotMap` 声明、`AppFrame` 的 `children` 表、`PropsRenderSlots` 键集、各占用包（`packages/client/ui-sidebar`、`packages/client/ui-open-in-app`）与 README 的 slot 表。
- **不变量**：布局状态按 `SessionId` 隔离；欢迎页底栏独占时右列为零宽，普通工作台关闭则隐藏底栏并保留偏好；工作台、底栏与详情的视觉关闭只做零尺寸加 `inert`，绝不卸载固定 React 树位置。
- **测试**：`pnpm exec vitest run packages/client/ui-layout/tests`

## packages/client/ui-slots

- **拥有**：slot 注册表纯核心与槽类型设计：`SlotMap` 声明合并、`SlotCore`（唯一 `register` 组合 API + 加载时校验 + 卸载级联）、四 share props 类型家族、`renderer.ts` 的安装约定（`SlotRenderer`/`SlotRendererHost`）。零运行时依赖，只有 React 类型。
- **不拥有**：cordis Service 层（`ctx.slots`、fiber 生命周期、`'slots/changed'`、`slots.inject`）在 `packages/client/runtime/src/client/slots.ts`；渲染实现（outlets、`SessionProvider`、uSES 适配）在 `packages/client/ui-renderer`。
- **入口**：`packages/client/ui-slots/src/index.ts`（静态单面包：无 `dsh.client`、无 `./client` 导出；`SlotCore` 构造时预置 `'root'`）。
- **接线**：不进 `cordis.patch.yml` 名录，作为基线外部件由 `packages/client/web/src/platform.ts` 的 `PLATFORM_MODULES` 预种。
- **关键文件**：`packages/client/ui-slots/src/index.ts`、`packages/client/ui-slots/src/renderer.ts`、`packages/client/ui-slots/src/store.ts`。
- **改这里要同步**：`register` 语义改动要同步 `packages/client/runtime/src/client/slots.ts` 与 `packages/client/ui-renderer/src/client/index.ts`，以及各包的 `SlotMap` 声明。
- **不变量**：一个 slot 只有一个声明者——向未声明 slot 注册、重复声明子 slot、chain 缺 `select`、同一共享 handle 挂两个 scope 都在 `register` 时抛出；disposer 递归折叠它声明的全部子 slot。
- **测试**：`pnpm exec vitest run packages/client/ui-slots/tests`

## packages/client/ui-conversation

- **拥有**：会话领域浏览器插件：常驻会话壳（`ConversationRoot`）、视图环（`conversation.view`）、Chat 流及其左缘轨迹定位细轨、Conversation Node 注册（`registerConversationNodes`/`registerChatNodeRenderers`）、输入区（`InputHub`/`InputBar`、composer 链、`ConversationController`）、审批面板、Todo/Queue dock、统计行，以及约 20 个 `conversation.*` slot 声明。
- **不拥有**：工具行展示属于 `packages/client/ui-tool`（占用 `conversation.chat.node`）；turn-tail 产物行属于 `packages/client/ui-deliverables`；轨迹视图属于 `packages/client/ui-trajectory`；侧边栏会话列表属于 `packages/client/ui-workspace`。
- **入口**：`packages/client/ui-conversation/src/client/index.ts`；组装点在 `packages/client/ui-conversation/src/client/apply.ts`。
- **接线**：`packages/bundle/web-app/cordis.patch.yml` 的 `ui-conversation` 行；`ConversationController` 以类插件形式自注册为 `conversation` 服务；node 半注册 `ui-conversation.busyEnter` settings 节。
- **关键文件**：`packages/client/ui-conversation/src/client/apply.ts`、`packages/client/ui-conversation/src/client/chat/ChatView.tsx`、`packages/client/ui-conversation/src/client/contract/slots.ts`、`packages/client/ui-conversation/src/client/service.ts`、`packages/client/ui-conversation/src/client/stores.ts`。
- **改这里要同步**：新 slot 改 `contract/slots.ts` 与 `apply.ts` 的 children 表；跨域类型只进 `contract/`（`scripts/verify-client-domain-graph.ts` 强制领域目录互不 import）；下游占用包。
- **不变量**：Chat 业务行是彼此独立的注册表贡献——新行注册一个 `ConversationNodeDefinition` 加 keyed `conversation.chat.node` renderer，绝不把事件 switch 折进 `Session`/`SessionManager` 或中央 renderer；`match(event)` 只读当前事件且按 log `seq` 可确定性回放。ChatView 的定位细轨仅从当前已加载的持久用户／中途引导节点取标记，并与消息流使用同一滚动容器；加载旧页后才增补标记。
- **测试**：`pnpm exec vitest run packages/client/ui-conversation/tests`

## packages/client/ui-open-in-app

- **拥有**：工作区打开能力的浏览器半：会话页头分体入口（`OpenInAppAction`）及文件侧栏、终端底栏开关（`WorkbenchPanelToggles`），均占用 `conversation.session.header.utilities`；欢迎页开关占用 `conversation.hero.actions`；内置文件工作台（`WorkspaceWorkbench`，占用 `workbench`）在全屏时由顶栏提供面板开关；保留式底栏终端（`RetainedTerminalPanel`）占用 `workbench.bottom`；另有 `OpenInAppController`。
- **不拥有**：Host 路由（应用启动、文件 list/read、终端 WebSocket）属于 `packages/host/open-in-app`；workbench 壳层几何与 `ctx.layout` 属于 `packages/client/ui-layout`；`conversation.session.header.utilities` 与 `conversation.hero.actions` 座位声明属于 `packages/client/ui-conversation`。
- **入口**：`packages/client/ui-open-in-app/src/client/index.ts`（注入 `slots`、`locale`、`layout`、`sessions`、`workspaces`；通过 `ctx.slots.inject(...)` 在各座位注册）；node 半是空 apply。
- **接线**：`packages/bundle/web-app/cordis.patch.yml` 的 `ui-open-in-app` 行与 host 行 `open-in-app` 并排挂载；共享常量经 `@deepseek-ai/dsh-host-open-in-app/shared`。
- **关键文件**：`packages/client/ui-open-in-app/src/client/index.ts`、`packages/client/ui-open-in-app/src/client/controller.ts`、`packages/client/ui-open-in-app/src/client/WorkspaceWorkbench.tsx`、`packages/client/ui-open-in-app/src/client/TerminalPanel.tsx`。
- **改这里要同步**：路由或帧协议改动同步 `packages/host/open-in-app`；面板显隐语义改动同步 `packages/client/ui-layout`（owner props `filesOpen`/`bottomOpen`），页头与欢迎页入口变动核对 `packages/client/ui-conversation` 的座位。
- **不变量**：文件树只回传当前 Session id 与 Host 返回的 provider segment 数组，绝不提交工作区根或自行拼接 Windows/POSIX/UNC 路径；隐藏底栏或关闭工作台只改布局可见性，不断开已激活终端。
- **测试**：`pnpm exec vitest run packages/client/ui-open-in-app/tests`

## packages/client/ui-theme

- **拥有**：主题运行时与全局样式：`ThemeRuntime`（`ctx.theme`、偏好 `light`/`dark`/`system`、`ThemeSnapshot` 发布、`theme/change`、token 覆盖层）、`--dsw-*` token 样式表（`src/styles/`，随插件生命周期挂卸）、Appearance 设置行与 `ui-theme.preference` settings 节。
- **不拥有**：DOM 投影（`color-scheme`、`body[data-ds-dark-theme]`、`meta[name=theme-color]`）属于 `packages/client/ui-layout` 的 `ThemePresenter`——`ThemeRuntime` 绝不触碰 DOM；settings 传输与 scope 属于 `packages/client/ui-settings` 与 `packages/client/runtime`。
- **入口**：浏览器半 `packages/client/ui-theme/src/client/index.ts`；node 半 `packages/client/ui-theme/src/index.ts`（注册 settings schema 并经 `webServer.tapIndex` 注入引导脚本）。
- **接线**：`packages/bundle/web-app/cordis.patch.yml` 的 `ui-theme` 行（`dsh.client` 带 `immediately: true`）；Appearance 行占用 `packages/client/ui-settings-general` 的 `settings.general.item`。
- **关键文件**：`packages/client/ui-theme/src/client/index.ts`、`packages/client/ui-theme/src/boot-theme.ts`、`packages/client/ui-theme/src/styles/design-platform.css`、`packages/client/ui-theme/src/client/styles.ts`。
- **改这里要同步**：token 与样式改动同步 `docs/web-styling.md` 与滚动条消费者；样式表顺序要保持 `scrollbar.css` 在 `design-platform.css` 之后。
- **不变量**：全局样式表只经插件持有注入（`?inline` + `ctx.effect` 挂卸），绝不进入静态 Web 外壳；`scrollbar-width`/`scrollbar-color` 必须留在 `@supports not selector(::-webkit-scrollbar)` 内，否则引擎会丢弃全部 `::-webkit-scrollbar*` 规则。
- **测试**：`pnpm exec vitest run packages/client/ui-theme/tests`

## apps/cli

- **拥有**：`dsh` 启动器本身——launcher flag 解析（`parseDshArgs`）、profile patch 层叠加与 boot（`runProfile`）、`dsh plugin` 的 pnpm 转发与 bundle 清单对账（`runPlugin`）、`--dump-config`、有界进程关机（`createProcessShutdown`）与随附 agent-preset root 注入。
- **不拥有**：应用参数解析（归注入的应用插件，经 `packages/boot/cmdline` 的 `ctx.cmdlineArgs`）；profile/patch 装载算法（归 `packages/boot/app-boot`）；一切插件能力（归 `packages/*`）；桌面壳启动（归 `apps/desktop-electron`）。
- **入口**：`apps/cli/src/bin.ts`（shebang 入口，按 `parseDshArgs` 结果动态 import 分发 profile/plugin/dump-config 三种模式）。
- **接线**：`apps/cli/package.json` 的 `bin: {"dsh": "lib/bin.js"}`（由 `apps/cli/tsdown.config.ts` 构建）；profile 模板与 `DEFAULT_PROFILE_BUNDLES` 在 `packages/boot/app-boot/src/profile.ts`。
- **关键文件**：`apps/cli/src/args.ts`、`apps/cli/src/profile-boot.ts`、`apps/cli/src/plugin.ts`、`apps/cli/src/process-shutdown.ts`、`apps/cli/src/dump-config.ts`。
- **改这里要同步**：`apps/cli/README.md` 与 `apps/cli/reference/README.md`；生成的组合图 `apps/cli/composition.md`（`pnpm run gen-doc-graphs`）；新插件行还要进 `packages/bundle/*/cordis.patch.yml` 与 `apps/cli/package.json` 依赖。
- **不变量**：launcher flag 必须在最前，第一个不认识的 token 起是应用参数（交给 `provideCmdline` 注入的快照；启动器绝不解析应用 flag）；profile 根配置是空 entry list，每次启动在 `prepareProfile` 中重写，组合只经 patch 层按 id 覆盖。
- **测试**：`pnpm exec vitest run apps/cli/tests/args.spec.ts`

## apps/desktop Go helper 与远程连接

- **拥有**：Electron helper、远程 SSH 服务和回环 bridge，以及供安装版使用的单实例锁。纯 Go 源码，没有 `package.json`，虽在 `apps/*` 通配下但不是 pnpm workspace 包。
- **不拥有**：Host 发现、启动与停止协议（归 `apps/internal/hostlaunch`）；窗口、菜单与托盘（归 `apps/desktop-electron`）；Host 与 UI 业务（归 `packages/*`、`apps/web`）；Electron 打包（归 `scripts/package-electron-macos-app.ts`）。
- **入口**：`apps/desktop/cmd/electron-helper/main.go`，由 Electron 主进程启动；helper 经 `hostlaunch` 启动 Host，Web 窗口导航至核验的回环 URL。
- **接线**：Host 侧以 `web --coding-host` 启动，该 flag 由 `packages/bundle/web-app/src/startup.ts` 解析，`packages/bundle/web-app/src/managed-host.ts` 发 `coding-host-ready` 记录。
- **关键文件**：`apps/desktop/internal/desktopremote/service.go`、`apps/desktop/internal/desktopremote/bridge.go`、`apps/desktop/internal/remoteagent/manager.go`、`apps/desktop/internal/instance/instance.go`、`apps/internal/hostlaunch/launcher.go`。
- **改这里要同步**：`apps/internal/hostlaunch`（启动与就绪记录契约）、Electron main/IPC（远程连接与进程协议）、`scripts/package-electron-macos-app.ts`（包资源）、`packages/bundle/web-app/src/managed-host.ts`（ready 记录格式）。
- **不变量**：开发版使用独立单实例锁与 `~/.dsh-electron-dev`，不得替换安装版的 Host；`DSH_HOME`/`DSH_CWD`/`DSH_APP_VERSION` 由 hostlaunch 独占写入；回环 origin 不是 bridge 授权。
- **测试**：`cd apps/desktop && go test ./cmd/electron-helper ./internal/desktopremote ./internal/helperwire ./internal/remoteagent ./internal/instance`

## apps/desktop-electron

- **拥有**：Electron 窗口、macOS 菜单和托盘、受限 Remote-SSH preload/main IPC、Go helper 客户端，以及开发与生产运行路径校验。
- **不拥有**：Remote-SSH 实现与 bridge（归 `apps/desktop/internal/desktopremote`）、Host 生命周期协议（归 `apps/internal/hostlaunch`）、UI 和会话（归 Client/Host 插件）；Browser Use 尚无受控 guest 或工具实现。
- **入口**：`apps/desktop-electron/src/main.ts`；Go 进程入口在 `apps/desktop/cmd/electron-helper/main.go`。`make dev` 与 `pnpm run dev:electron` 启动开发态；`build:desktop` 经 `scripts/package-electron-macos-app.ts` 组装生产包，`make install` 才将其安装到 `/Applications/Coding.app`。
- **关键文件**：`apps/desktop-electron/src/window.ts`、`native-chrome.ts`、`preload.ts`、`remote-ipc.ts`、`helper-client.ts`、`runtime-config.ts`、`apps/desktop/internal/helperwire/`。
- **改这里要同步**：Remote-SSH 输入与状态同步 `packages/client/ui-workspace/src/client/remote.ts`、`apps/desktop/internal/desktopremote` 与 `apps/desktop/cmd/electron-helper`；生产路径及资源同步 `scripts/build-electron-helper.ts`、`scripts/package-electron-macos-app.ts` 和 `apps/desktop-electron/README.md`。
- **不变量**：main 对每次 IPC 核验窗口、主 frame、精确 Host origin 和输入；同源重载期间暂停授权，窗口丢失即撤权；helper 不经 renderer 转交 SSH 凭据或 bridge token。生产配置使用共享 `~/.dsh`，Go helper 在操作前取得安装版单实例锁；Chromium `userData` 使用独立目录。
- **测试**：定向运行 `pnpm exec vitest run apps/desktop-electron/tests scripts/build-electron-helper.spec.ts scripts/package-electron-macos-app.spec.ts` 和 `cd apps/desktop && go test ./cmd/electron-helper ./internal/desktopremote ./internal/helperwire`；开发窗口另跑 `pnpm run test:electron:smoke`，回环 SSH fixture 分别运行 `pnpm run test:electron:remote-basic` 与 `pnpm run test:electron:remote-ssh`，打包版启动用 `pnpm run test:electron:packaged` 单独验证。

## packages/bundle/base

- **拥有**：所有 profile 共享的第一层 patch：`cordis.patch.yml` 的单一 insert（timer/hmr/llm/session/工具/持久化/沙箱/subagent/settings/credentials/telemetry），以及 bash/pwsh 双 shell 栈的平台门控。包本身没有运行时 API（`src/index.ts` 只有 `export {}`）。
- **不拥有**：模式专属配置值（归 `packages/bundle/web-app`、`packages/bundle/headless`——patch 整行替换 `config`，没有深度合并）；各行插件的实现（归行 `name` 指向的包）；可选的 Codex/Claude Code provider（明确排除在依赖闭包外）。
- **入口**：`packages/bundle/base/cordis.patch.yml`（经 `package.json` 的 `dsh.bundle.patch` 声明，组合器只按该字段解析，绝不 import 代码）。
- **接线**：`packages/boot/app-boot/src/profile.ts` 的 `PROFILE_TEMPLATES`（web/headless 都以 `@deepseek-ai/dsh-base` 开头）；`apps/cli/src/profile-boot.ts` 的 `composeProfile` 按 `dsh.profile.bundles` 顺序叠加。
- **关键文件**：`packages/bundle/base/cordis.patch.yml`、`packages/bundle/base/package.json`、`packages/bundle/base/src/invariant.ts`、`packages/bundle/base/tests/base.spec.ts`。
- **改这里要同步**：`apps/cli/package.json` 依赖；生成的 `apps/cli/composition.md`（`pnpm run gen-doc-graphs`）与 `docs/map/wiring.md`（`pnpm run gen-code-map`）；受影响行的包 README。
- **不变量**：patch 替换目标行的整个 `config`，模式差异值不放这里；`bash-sandbox`/`tool-bash` 与 `pwsh-sandbox`/`tool-pwsh` 用互逆的 `disabled: !!js process.platform === 'win32'` 门控，每宿主恰好挂一个 shell 栈。
- **测试**：`pnpm exec vitest run packages/bundle/base/tests/base.spec.ts`

## packages/host/open-in-app

- **拥有**：在工作区打开本地应用的 Host 半边——编译期应用 catalog 的惰性平台解析、图标提取、启动端点、Session 绑定的只读文件协议、用户终端 WebSocket upgrade，以及全部路由安全栅栏。
- **不拥有**：浏览器侧 UI 与分流（归 `packages/client/ui-open-in-app`）；HTTP 载体（归 `packages/host/webserver` 的 `ctx.webServer`）；认证栅栏服务 `requestRejection`（归 `packages/client/connection`）；PTY 与 subprocess 机制（归 `packages/subprocess`）。
- **入口**：`packages/host/open-in-app/src/index.ts`（函数插件 `name = 'open-in-app'`，注册 `/open-in-app/*` 路由与终端 upgrade）。
- **接线**：`packages/bundle/web-app/cordis.patch.yml` 的行 `open-in-app`，与客户端行 `ui-open-in-app` 成对。
- **关键文件**：`packages/host/open-in-app/src/index.ts`、`packages/host/open-in-app/src/workspace.ts`、`packages/host/open-in-app/src/terminal.ts`、`packages/host/open-in-app/src/resolver.ts`、`packages/host/open-in-app/src/catalog.ts`。
- **改这里要同步**：`packages/client/ui-open-in-app`（wire 与交互）、`docs/map/wiring.md`、包 README 的路由与安全表。
- **不变量**：每条 HTTP 路由与 upgrade 先调 connection 的 `requestRejection`（只收 loopback 且同源），拒绝发生在读载荷、查 Session、分配 PTY 之前；工作区根只从 `Session.header.cwd` 解析，路径逐段匹配 `ctx.fs.listDir` 子项并以 `ctx.fs.contains` 复核，浏览器字符串绝不拼成 OS 路径；Remote-SSH marker 或 SSH 启动一律 fail-closed 到 `files` 分支。
- **测试**：`pnpm exec vitest run packages/host/open-in-app/tests/host-routes.spec.ts`

## packages/host/directory-picker（含 -native、-browse、-auto）

- **拥有**：目录选择能力全家——`directory-picker` 是 Service Definition（抽象类 `DirectoryPicker` 注册 `ctx.directoryPicker`，能力联合类型 `DirectoryPickerCapabilities` 可声明合并扩展，`DirectoryPickerError` 带封闭错误码）；`-native` 是原生 OS 面板后端（macOS JXA/osascript、Linux Zenity/KDialog、Windows koffi 驱动的 `IFileOpenDialog`）；`-browse` 是应用内浏览后端（Node 标准库单层列举与建目录，服务远程客户端）；`-auto` 在启动时一次性判定后端，并把匹配后端作为内存根树 Loader 条目挂载（`BACKEND_PACKAGES`/`SURFACE_PACKAGES` 是固定组合词汇）。
- **不拥有**：客户端交互流（归 `packages/client/ui-directory-picker-browse`、`packages/client/ui-directory-picker-native`）；目录流 slot 定义（归 `packages/client/ui-workspace`）；免 shell 命令运行器（归 `packages/util/native-command`）。
- **入口**：`packages/host/directory-picker/src/index.ts`（`DirectoryPicker` 默认导出与 `ctx.directoryPicker` 声明）。
- **接线**：随包 web 组合在 `packages/bundle/web-app/cordis.patch.yml` 的行 `directory-picker` → `@deepseek-ai/dsh-host-directory-picker-browse`（配 `ui-directory-picker-browse`）；`-native` 与 `-auto` 由覆盖层显式选择。
- **关键文件**：`packages/host/directory-picker/src/index.ts`、`packages/host/directory-picker-browse/src/index.ts`、`packages/host/directory-picker-native/src/index.ts`、`packages/host/directory-picker-native/src/native-picker.ts`、`packages/host/directory-picker-auto/src/index.ts`。
- **改这里要同步**：对应的 client 包、`packages/client/ui-workspace` 的 slot 契约、web-app 组合行、各 README 的限制一节、`docs/map/wiring.md`。
- **不变量**：一个组合只挂一个后端——第二个会因为重复 `directoryPicker` 服务与 `single` slot 在加载期直接失败；能力对象在服务生命周期内必须稳定（消费方可跨调用捕获）；`-auto` 挂载的条目只进内存根树，绝不持久化进配置文件。
- **测试**：`pnpm exec vitest run packages/host/directory-picker/tests/seam.spec.ts packages/host/directory-picker-browse/tests/service.spec.ts packages/host/directory-picker-auto/tests/resolve.spec.ts`

## packages/terminal/terminal

- **拥有**：持久 PTY 能力三件套——`terminal` 是 Service Definition（`TerminalSessionService` 默认导出，注册 `ctx.terminals`，mint 不透明 `TerminalSessionId`，所有者限定、发布、授权与等待停稳）；`terminal-bash` 是唯一的 PTY 后端（函数插件，注册后端 type `shell`，bash 与 pwsh 双方言，基于 `ctx.subprocess.spawnTerminal`）；`tool-terminal` 是模型消费方（6 个 `terminal_*` 工具）。
- **不拥有**：PTY 与 node-pty 分配、环境清理、进程树终止（归 `packages/subprocess/subprocess-local`）；沙箱策略裁决（归 `packages/sandbox/sandbox-policy`，经 `ctx.sandboxPolicy.resolve`）；后台任务（归 `packages/jobs`）。
- **入口**：`packages/terminal/terminal/src/index.ts`（`TerminalSessionService` 服务类默认导出；类型与 `TerminalBackend` 接口在 `src/types.ts`）。
- **接线**：不进 base 或 web-app 组合，按 agent 平面组合在 `apps/cli/config/agent-presets/minimal/agent.cordis.yml` 的 `persistent-shell` group 内（`isolate: terminals: true`，行 `pty` 与互斥的 `terminal-bash`/`terminal-pwsh`）；opt-in 示例 `examples/acp-agent/pty.cordis.yml`。
- **关键文件**：`packages/terminal/terminal/src/index.ts`、`packages/terminal/terminal-bash/src/index.ts`、`packages/terminal/terminal-bash/src/session.ts`、`packages/terminal/tool-terminal/src/index.ts`。
- **改这里要同步**：消费它的 preset（`apps/cli/config/agent-presets/*/agent.cordis.yml` 与 `preset.yml`）、`packages/shell/tool-bash-persistent`/`tool-pwsh-persistent`（复用同一 registry）、`docs/map/wiring.md` 与工具目录生成物。
- **不变量**：每个操作限定完全相同的活跃 `Agent`（owner-scoped，跨 agent 不可见）；后端注册稳定 `type` 并返回尚未发布的 session，清理失败以 `TerminalBackendCleanupError` 保留；每宿主恰好一个 shell 栈（`disabled: !!js process.platform` 互逆表达式）；registry 是 agent 域服务，必须由 Loader 装配而不是手工 new。
- **测试**：`pnpm exec vitest run packages/terminal/terminal/tests/service.spec.ts packages/terminal/terminal-bash/tests/session.spec.ts packages/terminal/tool-terminal/tests/tools.spec.ts`

## packages/settings/settings 与 packages/credentials/credentials

- **拥有**：两个对称的 Service Definition seam——`SettingsProvider`（`ctx.settings`：namespace schema 注册、`schema 默认 → 组合 base → 用户分节` 三层解析、`describe({redactSecrets})`、`update`/`replace`/`mutate` 深合并与 `expectedRevision` 冲突拒绝）与 `CredentialProvider`（`ctx.credentials`：`credentialRef` 品牌化引用、`resolve`/`describe`/`set`/`unset`，配置只带引用不带机密）。
- **不拥有**：文档存储与热重载（归 `packages/settings/settings-file` 与 `packages/credentials/credentials-local`）；各消费方 namespace（例如 `llm-deepseek` 分节归适配器包）；设置 UI（归 `packages/client/ui-settings`、`packages/client/ui-settings-models`）。
- **入口**：`packages/settings/settings/src/index.ts`（`SettingsProvider` 抽象类）与 `packages/credentials/credentials/src/index.ts`（`CredentialProvider` 抽象类，`notifyUpdated` 扇出 `credentials/updated`）。
- **接线**：base 组合的行 `settings` → `@deepseek-ai/dsh-settings-file`、行 `credentials` → `@deepseek-ai/dsh-credentials-local`（`$DSH_HOME/settings.yaml` 热重载，`$DSH_HOME/.credentials.yaml` 受管存储）。
- **关键文件**：`packages/settings/settings/src/index.ts`、`packages/settings/settings/src/redact.ts`、`packages/credentials/credentials/src/index.ts`、`packages/settings/settings-file/src/index.ts`、`packages/credentials/credentials-local/src/index.ts`。
- **改这里要同步**：两个 provider 包的 README 与测试（写锁、原子写、watcher 语义成对演化）、消费方适配器（`apiKeyEnv` 引用按操作解析）、`./types` 子路径的事件声明与 client 投影。
- **不变量**：配置只携带对机密的引用（例如 `apiKeyEnv: DEEPSEEK_API_KEY`），值只在 provider 处；消费方按操作 `resolve`，绝不跨操作缓存；空存储值处处等于不存在；`set`/`unset` 被只读来源遮蔽时明确拒绝而不是表面成功；单个 listener 抛错不影响其余。
- **测试**：`pnpm exec vitest run packages/settings/settings/tests/settings.spec.ts packages/credentials/credentials/tests/credentials.spec.ts`
