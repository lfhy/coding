# coding-client-ui-settings-proxy-pool

代理池设置分区：向 `settings.section` 注册一页（`proxy-pool`，模型分区之后），管理代理池节点（点击**导入**按钮后在模态框中按行粘贴分享链接、连通性测试、删除）与池自己的出站控制（**直连**／**代理池**／**自定义代理**）。

渠道级的出站选择（直连／内置代理池／自定义代理）在**设置 → 模型**的渠道详情里，不在这里；渠道选择内置代理池时使用本分区的出站：池为直连时渠道也直连，池为代理池时经本地入站，池为自定义代理时经这里填写的地址。只有「代理池」会启动自动刷新订阅与节点探测；手动测试与刷新始终可用。

数据全部来自 Host 的 `proxyPool` RPC 域（`coding-host-apiproxy`）：`describe` 返回节点、健康快照、池规则与本地入站地址，`setPoolMode` 写 `proxy-pool` 设置分节。本包不持有任何池状态，快照由 [`store.ts`](src/client/store.ts) 经 connection 的 wire 客户端拉取，动作完成后自动刷新。节点凭据只在本机 Host 侧存在，线视图仅携带 `hasSecret` 一类存在性标志。节点表的横向滚动限制在列表区域内，不会撑开设置内容区；探测失败的完整原因以状态图标展示，鼠标悬停或键盘聚焦图标时在浮窗中显示。

## 注册

- slot：`settings.section`（`id: proxy-pool`，`order: 16`）。
- 服务：`slots`、`locale`、`connection`。
- 文案：`settings.proxy-pool` 命名空间（字符串键入 locale 词典；带参数的
  文案函数由注入闭包按当前语言直出）。

## Model Experience

### Request context and condition

#### What the model sees

None — 设置界面不进入模型上下文。

#### Token effect

零直接影响。

#### KV Cache effect

不使任何模型请求缓存失效；池的出站与节点选择只改变 TCP 路径，不改变请求字节。

## Known Limitations and Deferred Work

- **节点操作不支持批量处理**：测试和删除仍按单个节点执行。
- **池页不展示谁在使用池**：渠道级出站选择在模型页，本分区不列出正在选择内置代理池
  的渠道。
- **池出站切换不取消进行中的一轮刷新**：切到直连或自定义代理会停止后续排期，已经发出
  的一轮刷新自然结束，其收尾不再排期。
