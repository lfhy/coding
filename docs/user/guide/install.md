# 安装 Coding

Coding 以同一个本地 agent Host 提供两种客户端：macOS 与 Windows 的原生桌面 GUI，以及 Linux 的交互式终端界面。所有客户端共享同一个 `$DSH_HOME`（默认 `~/.dsh`），会话、设置和凭据集中保存。

## 平台矩阵

| 平台 | 客户端 | 产物 |
| --- | --- | --- |
| macOS arm64 | 原生 GUI（WKWebView） | `Coding.app` / `.dmg` |
| Windows x64 | 原生 GUI（WebView2） | 安装包 |
| Linux x64 | 交互式终端界面 | 单个 `coding` 可执行文件 |

## 本机运行的进程

macOS 的 `Coding.app` 将 Node 可执行文件放在 `Coding.app/Contents/Resources/coding-host`，并将预展开的 Host 闭包放在 `Coding.app/Contents/Resources/runtime`。应用直接从这份只读闭包启动，不会向用户主目录解压运行时，也无需单独安装 Node。

Linux 的 `coding` 可执行文件仍使用 Node SEA 归档。首次运行会把运行时物化到 `$DSH_HOME/runtime/<sha256>` 并从该目录启动 Host。目录名是归档内容哈希，因此后续产品版本若携带相同字节会复用该目录。当前归档成功启动后只保留该归档对应的运行时目录。

Host 只绑定回环地址。客户端通过 `$DSH_HOME/host.json` 发现 Host，并使用现有 HTTP/WebSocket API 连接；空闲（无客户端连接且无运行中任务）的 Host 在五分钟后自动退出。

## 安装桌面应用

下载对应平台的发布产物并手动安装：

- macOS：挂载 `.dmg`，把 **Coding** 拖入 `Applications`。
- Windows：运行安装包。若缺少 WebView2 运行时，应用会先显示微软官方下载链接再退出。

从应用菜单启动 **Coding**。窗口直接加载本地 Web 界面，不依赖浏览器。再次启动会聚焦已有窗口，而不是新开应用。在 macOS 上，关闭主窗口会让 Coding 保留在菜单栏；通过状态项显示或隐藏窗口，选择 **退出 Coding** 才会结束桌面应用。

## 安装 Linux 客户端

把 `coding` 可执行文件复制到 `PATH` 中的目录，例如 `/usr/local/bin`：

```sh
sudo install coding /usr/local/bin/coding
```

在任意终端运行 `coding`。使用 `coding --cwd <dir>` 更改默认工作目录。

## 数据位置

会话、设置、凭据和插件都保存在 `$DSH_HOME` 下；Linux 客户端的物化运行时也保存在这里。设置 `DSH_HOME` 环境变量可以整体迁移这些用户数据。删除该目录即恢复全新安装。
