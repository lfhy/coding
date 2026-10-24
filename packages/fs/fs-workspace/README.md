# coding-fs-workspace

[`coding-fs`](../fs/README.md) 的多后端装配：加载它即由 `ctx.fs` 提供 `FsRegistry`，默认注册两个后端——包了沙箱围栏的本地后端，以及 Remote-SSH 后端。

## 为什么需要装配层

一个 Host 会同时服务本地目录和多个远端工作区，而 `ctx.fs` 只有一个服务名。装配层把"哪个后端负责哪个工作区"交给注册表：异步原语按调用方传入的 `opts.cwd` 选择后端，同步原语按不透明 target key 的前缀选择。工具层（`coding-tool-fs`、`coding-tool-fs-search`、`coding-lsp-stdio`）继续只调用 `ctx.fs`。

选择顺序：

1. `ctx.fs.bind(cwd, backendId)` 记录的显式工作区绑定；
2. 后端的 `matches(cwd)`，后注册者优先（远端后端异步识别 marker 占位目录）；
3. 最近注册的后端兜底，也就是本地后端。

## 装配内容

| 后端 | id | 角色 |
|---|---|---|
| `SandboxedBackend` 包装 `LocalFileSystemBackend` | `local` | 本地执行世界；变更按调用策略围栏（`read-only` 拒绝、`workspace-write` 限工作区与临时区、`danger-full-access` 放行） |
| `RemoteWorkspaceRouter` | `remote-workspace` | Remote-SSH 执行世界；经已认证回环 bridge 读写远端文件，可访问整台远端主机 |

`ctx.fs.sandboxMode` 返回第一个声明了模式的后端（即沙箱包装层）的部署默认值，`coding-tool-fs` 用它决定是否展示升权提示。

装配配置就是本地后端的两项参数：`cwd`（相对路径的解析默认值，默认 `process.cwd()`）与 `diffBasisMaxBytes`（覆写 diff 的基准上限，默认 10 MiB）。

## 依赖

需要 `ctx.sandboxPolicy`（[`coding-sandbox-policy`](../../sandbox/sandbox-policy/README.md)）先就绪；装配会等它注入后构造。远端能力还要求桌面端已发布 marker 与 bridge token，否则远端目标只在同步身份方法上可用，I/O 会以 `FS_IO_ERROR` 失败，不会回退到本地执行世界。

## 模型体验

经由 `coding-tool-fs` 间接生效：模型看到的 `read`／`write`／`edit` 结果、目录列表与错误分类都来自被选中的后端，装配本身不产生新的模型可见文本。

#### KV Cache 影响

无直接失效；请求前缀变更由具名消费方负责。

## 已知限制与暂缓事项

- **绑定需要工作区生命周期维护**：`bind()` 的调用者是工作区创建与恢复流程，本包只提供注册与撤销；没有绑定记录时依赖 `matches` 兜底。
- **同一 cwd 的多工作区**：`cwd` 作键在"同目录两个后端"时不唯一，需要按 workspace id 消歧时再扩展绑定键。
- **远端搜索仍绕开 `ctx.fs`**：`coding-tool-fs-search` 直接走 bridge，尚未改为经注册表取搜索能力。
