# coding-git-local

Git seam（`ctx.git`，见 [`coding-git`](../git/README.md)）的本机实现。有 `git` 可执行文件时驱动它；没有时用内置的纯 JavaScript 实现完成克隆，所以“打开仓库”在没有安装 Git 的机器上仍然可用。两种机制共享同一套凭据优先级与失败词汇，消费方只依赖 seam 的服务签名。

## 子进程约定

`git` 子进程固定 `LC_ALL=C`，让失败分类不随宿主语言改变；终端提示、SSH 交互提示与宿主凭据助手默认关闭，只有 HTTPS 远端且本次没有显式凭据的第一轮尝试才允许凭据助手参与。凭据通过一次性的 askpass 子进程提供，不进入命令行、环境变量或日志。输出按命令设定上限（日志 2 MiB、refs 256 KiB、通用 4 MiB），超限即失败而不返回部分结果。

## 克隆

`clone` 接收远端地址、目标目录与可选的分支、深度、代理、提交身份与凭据：

- 目标目录必须不存在或为空目录，否则以 `GIT_TARGET_EXISTS` 失败；克隆失败或取消时会删除本次创建的目录，不留下半成品工作区。
- 提交身份（`identity`）写入新仓库的本地配置，后续自动提交使用它；留空的字段保持目标机器上的 git 配置。`git clone` 的 `-c` 只影响那一次命令，不会落到新仓库。
- 认证按宿主凭据助手、本机凭据存储、调用方显式凭据的顺序解析；前两级都给不出可用凭据时以 `GIT_AUTH_REQUIRED` 请求输入，已存凭据被拒时同一个错误带上 `credentialRef`。

内置实现使用 `isomorphic-git` 加本包自己的 `node:http(s)` 适配器（可按调用方信号中止，不经过第三方请求库）。它只支持 http(s) 远端。代理同样可用：显式 `proxy` 优先，留空时读 `HTTPS_PROXY`／`HTTP_PROXY`／`ALL_PROXY`（含小写拼写）并尊重 `NO_PROXY`；隧道由 [`coding-proxy-pool`](../../net/proxy-pool/README.md) 的拨号器建立，HTTP(S) 前向代理与 SOCKS5 都走同一条路径，目标为 https 时 TLS 由本进程完成，代理只看到密文。代理连不上或地址不可解析时以 `GIT_REMOTE_UNAVAILABLE` 失败，不会退回直连。克隆后同样写入提交身份，结果里的 `mechanism: 'js'` 让界面说明本次用的是内置实现。

## 模型体验

无。本包只回答宿主的 Git RPC；这里没有任何内容进入模型请求。

#### KV Cache 影响

无；该包既不组装也不发送提供方请求。

## 已知限制与暂缓事项

- **内置实现只覆盖克隆**：状态、分支、历史、切换、推送与拉取在有 `git` 的机器上才可用；未安装时这些 RPC 以 `GIT_UNAVAILABLE` 失败，由界面提示安装 Git。
- **内置实现不支持 SSH 与本机路径远端**：只处理 http(s) 智能协议；`git@host:owner/repo` 需要本机 `git`。
