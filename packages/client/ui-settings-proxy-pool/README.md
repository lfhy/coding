# coding-client-ui-settings-proxy-pool

代理池设置分区：向 `settings.section` 注册一页（`proxy-pool`，模型分区之后），
管理代理池节点（分享链接导入、连通性测试、删除）与 Free 渠道的出站方式
（直连／代理池／自定义代理）。

数据全部来自 Host 的 `proxyPool` RPC 域（`coding-host-apiproxy`）；本包不持有
任何池状态，快照由 [`store.ts`](src/client/store.ts) 经 connection 的 wire 客户端
拉取，动作完成后自动刷新。节点凭据只在本机 Host 侧存在，线视图仅携带
`hasSecret` 一类存在性标志。

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

不使任何模型请求缓存失效；出站方式只改变 TCP 路径，不改变请求字节。

## Known Limitations and Deferred Work

- **无分区级样式**：首版复用浏览器默认表单控件，视觉未接入 `--dsw-*` token
  体系；接入设计系统是首个后续工作。
- **出站方式与模型页未互斥提示**：在模型分区看不到「当前 Free 渠道经代理池出站」
  的提示，两个分区各自独立操作。
