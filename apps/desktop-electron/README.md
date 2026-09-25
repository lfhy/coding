# Electron 桌面开发原型

这个私有应用在 macOS 上与 [Wails 桌面壳](../desktop/main.go)并存，用同一套 Web Client 和独立 Node Host 验证 Electron 窗口。它不是安装包或默认桌面入口；`make dev`、`make install` 和 `pnpm run build:desktop` 仍使用 Wails。桌面壳的迁移验收范围见[对比说明](../../docs/desktop-shell-comparison.md)。

## 本机运行

先按[开发指南](../../docs/development.md)安装锁定依赖，再从仓库根目录运行：

```sh
pnpm run dev:electron
```

该命令先构建 Host、Client 与 Web，再构建 Electron 壳、安装匹配的 Electron 开发二进制并启动。初次运行需要下载 Electron。仅构建 Electron 壳时使用 `pnpm run build:electron`；它不构建 Host、Web、安装包或 Wails 壳。`pnpm run test:electron:smoke` 是需本机图形会话的可选原生冒烟验证，不属于无凭据的默认测试。Electron 开发壳从仓库源码启动 `web --coding-host`，需要 PATH 中可用的 Node；开发实例不自动取得安装版的设置或凭据。真实模型请求不属于此阶段验收；如需手动尝试，使用显式环境变量，或在隔离的 `~/.dsh-electron-dev/workspace/.env` 中配置凭据。CLI 在读取 `.env` 前切换到该工作目录，因此不会加载仓库根目录的 `.env`；不要将 API key 写进仓库。

## 数据与连接

开发 Host 使用 `~/.dsh-electron-dev`，Electron 的 `userData` 使用其中的 `electron-user-data/`，Host 默认工作目录和 Agent 数据分别使用 `workspace/` 与 `agents/`。启动时先核验开发 home 的实际路径，再创建子目录；若它指向安装版 `~/.dsh` 或 Wails 开发版 `~/.dsh-dev` 则拒绝启动。单实例锁只约束这个 Electron 应用，Host 子进程也不会继承 Wails 的 Remote-SSH bridge 地址和 token。

主进程只在独立 home 中发现或启动 Host：校验 `host.json` 的协议、PID 和端口，将其与 `host.describe` 返回的所有权 token 对照，再让窗口直连精确的 `http://127.0.0.1:<端口>`。无法证实已有活跃 Host、就绪记录不一致、探测失败或启动超时时会报错，不会因同机存在一个回环端口就加载它。Host 不随窗口关闭而被强制终止，仍按自身空闲策略退出；macOS 再次激活应用会重新发现 Host。

窗口只允许导航到已验证 Host 的同一 origin，阻止弹窗和跨源 frame 导航，并拒绝网页原生权限请求。Renderer 禁用 Node integration、启用 context isolation 与 sandbox；本原型不提供 preload、原生 IPC 或 Browser guest。Host 的 HTTP 和 WebSocket 仍由网页直接访问，回环 origin 不是身份认证，也不能把 Host 发现 token、凭据或私有路径放进 URL 和页面存储。

## 范围与待验证事项

这是 macOS 开发原型，尚未交付生产打包或跨平台支持。Remote-SSH、Go bridge、托盘、Browser Use 和 CDP 均不在此应用中；不要用它替代 Wails 验证这些功能。可选原生冒烟已验证真实 Host 页面、`host.describe`、两条 WebSocket、导航/权限拒绝、入门输入焦点和第二实例恢复原窗口；锁屏时 macOS 不授予前台焦点，测试会明确标记该项未验证。流式输出、取消、下载、重连、关闭与复开窗口后的 Host 生命周期及安装版隔离仍待针对性实测。后续加入原生能力时须另行定义受限的 main/helper 协议和逐调用授权，不在 renderer 中复制 Host 业务。
