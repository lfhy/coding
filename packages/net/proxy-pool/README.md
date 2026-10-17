# coding-proxy-pool

出站代理池：把一组代理节点（HTTP/SOCKS5/VLESS/VMess/Hysteria2 分享链接导入）聚合成
一个**本地 HTTP 代理入站**，消费方（Free 渠道、任意 OpenAI 兼容渠道）只需指向
`http://127.0.0.1:<port>` 即可获得跨节点故障转移能力。服务伴随宿主进程启动与停止，
不落任何外部进程或文件。

## 能力

- **节点注册表**：`registerNode` / `registerGroup` 注册节点与组，重复 id 抛
  `PROXY_NODE_DUPLICATE` / `PROXY_GROUP_DUPLICATE`；变更经 `proxy-pool/node` 事件发布。
- **分享链接导入**：`parseProxyLink` / `parseProxyLinks` 解析
  `vless://`、`vmess://`（base64 JSON）、`hy2://`/`hysteria2://`、`socks5://`、
  `http(s)://` 形态；不可解析的行跳过并计数。
- **双形态入站**：本地端口同时接受 CONNECT 隧道（https 目标）与正向代理请求
  （明文 http 目标——undici 的 ProxyAgent 对 http 目标不发 CONNECT，这是它的设计）。
- **组选择**：`fallback`（按序取第一个健康节点）与 `url-test`（取延迟最低的健康节点），
  无健康数据时回落首位候选。
- **健康检查**：周期经每节点拨号探测（间隔/超时可配），结果记入 `ProxyHealth` 并以
  `node-health` 事件发布；`checkNode` 也可手动触发。
- **生命周期**：`ctx.effect` 持有入站监听、探测定时器与活跃连接表；fiber 释放时
  全部销毁，不留端口与悬挂句柄。

## 协议实现说明

- HTTP 与 SOCKS5 按 RFC 逐字节实现握手（SOCKS5 支持无认证与用户名/密码两种方法）。
- VLESS 按官方规范实现请求头（版本 0 + UUID + 指令 + 地址）；TLS 与 WebSocket 传输
  由节点描述符声明。
- VMess 只实现 **AEAD**（alterId=0）请求头：HKDF 派生密钥 + ChaCha20-Poly1305 封装
  （Node webcrypto）；legacy alterId 明确拒绝。**注意**：VMess 的负载流加密
  （AES-128-CFB chunk 流）尚未实现，当前 VMess 节点能完成握手但数据面不可用——
  见「已知限制」。
- Hysteria2 需要 QUIC 栈；当前构建对 hysteria2 节点拨号直接给出
  `PROXY_PROTOCOL_UNSUPPORTED`，不静默直连。

## 使用

```ts
// 组合层安装（base 组合已包含）：
// - id: proxy-pool
//   name: 'coding-proxy-pool'

const pool = ctx.proxyPool
await pool.ready()
const dispose = pool.registerNode(parseProxyLink('socks5://1.2.3.4:1080#node-a'))
pool.registerGroup({ id: 'g', name: '主组', members: ['<node-a-id>'], strategy: 'fallback' })
pool.useGroup('g')
const url = pool.proxyURL({ kind: 'pool' }) // http://127.0.0.1:<port>
```

消费方拿到的 `url` 直接喂给 undici `ProxyAgent` 即可；`proxyURL({ kind: 'direct' })`
返回 `undefined` 表示直连。

## 错误码

| code | 含义 |
| --- | --- |
| `PROXY_LINK_INVALID` | 分享链接形态不合法或不支持的 scheme |
| `PROXY_DIAL_FAILED` | 节点握手失败（连不上、CONNECT 被拒、协议应答错误） |
| `PROXY_PROTOCOL_UNSUPPORTED` | 协议在当前构建不可用（hysteria2） |
| `PROXY_NODE_DUPLICATE` / `PROXY_GROUP_DUPLICATE` | 注册表内 id 冲突 |
| `PROXY_POOL_NOT_READY` | 入站服务器未运行时取池地址 |

## Model Experience

### 通过本适配器发起的提供方请求

#### What the model sees

None — 代理池是纯传输层能力，模型可见内容不因出站路径变化。

#### Token effect

零直接影响；经代理的请求与直连在 token 上无差异。

#### KV Cache effect

不影响模型请求的缓存语义；换节点只改变 TCP 路径，不改变请求字节。

## Known Limitations and Deferred Work

- **VMess 数据面未完成**：AEAD 请求头已实现并可完成握手，但负载的 chunk 流加解密
  （AES-128-CFB）尚未接线；接好前 VMess 节点不可用于真实转发。VLESS/HTTP/SOCKS5
  均已完整可用。
- **Hysteria2 需要 QUIC 栈**：引入 QUIC 实现前该协议明确拒绝。
- **节点凭据是明文描述符**：`ProxyNode.secret` 是普通字段；接入设置持久化时由
  设置层决定是否走凭据存储。
- **并发代理请求共享全局 dispatcher**：`llm-opencode` 的出站切换按请求替换 undici
  全局 dispatcher；两个真正并发的代理请求会互相覆盖，Free 渠道的串行请求模式不受
  影响，见 `llm-opencode/src/outbound.ts` 的说明。
