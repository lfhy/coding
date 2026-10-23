# coding-proxy-pool

出站代理池：把一组代理节点（HTTP/SOCKS5/VLESS/VMess/Hysteria2 分享链接导入）聚合成
一个**本地 HTTP 代理入站**，消费方（Free 渠道、DeepSeek 渠道等）在自己设置里选择
「内置代理池」后指向 `http://127.0.0.1:<port>` 即可获得跨节点故障转移能力。服务伴随
宿主进程启动与停止，不落任何外部进程或文件。

池有自己的**出站控制**（`proxy-pool` 设置分节的 `mode`）：`direct`（缺省）、`pool`
或 `custom`（`customUrl`）。渠道级出站选择属于各渠道自己的设置分节，渠道选择
「内置代理池」时使用这里的出站——直连规则下 `proxyURL({ kind: 'pool' })` 返回
`undefined`，渠道回落直连；自定义代理规则返回池配置的地址；只有 `pool` 规则启动
后台健康检查与订阅刷新并提供本地入站地址。

## 能力

- **节点持久化**：手工导入的节点镜像到 `proxy-pool-nodes` 设置分节（链接行
  形态，导入/删除即写盘），重启后自动重放恢复；订阅刷新的 `feed:` 临时节点
  不落盘。链接行覆盖各协议字段（vless 的 TLS/ws 参数、vmess 的 base64 JSON、
  hysteria2 的 sni/insecure），往返无损。没有设置提供方时为 no-op，池照常
  运行只是节点随进程结束。
- **池的出站控制**：`proxy-pool` 分节的 `mode` 是池自己的出站。`direct`（缺省）与
  `custom` 都不经本地入站，因此不启动后台循环；只有 `pool` 启动健康检查与订阅刷新
  并向消费方提供本地地址。手动 `pool.refresh()` 与 `pool.checkNode()` 在所有规则下都可用。
- **订阅自动刷新**：免费节点寿命只有分钟级，静态导入几分钟就过期。池规则为 `pool`
  时每 5 分钟从内置公开目录（proxifly、monosans）拉取候选，**先探测再入池**（8 并发、
  5s 超时，通过者以 `feed:` 前缀入池并携带探测健康记录），并移除候选集里已消失的旧
  `feed:` 节点；用户手工导入的节点绝不触碰。拉取经镜像回退链（直连 → gh-proxy.com），
  单源失败只记入摘要不中断整轮。`pool.refresh()` 手动触发同一动作。
- **节点注册表**：`registerNode` / `registerGroup` 注册节点与组，重复 id 抛
  `PROXY_NODE_DUPLICATE` / `PROXY_GROUP_DUPLICATE`；变更经 `proxy-pool/node` 事件发布。
- **分享链接导入**：`parseProxyLink` / `parseProxyLinks` 解析
  `vless://`、`vmess://`（base64 JSON）、`hy2://`/`hysteria2://`、`socks5://`、
  `http(s)://` 形态；不可解析的行跳过并计数。
- **双形态入站**：本地端口同时接受 CONNECT 隧道（https 目标）与正向代理请求
  （明文 http 目标——undici 的 ProxyAgent 对 http 目标不发 CONNECT，这是它的设计）。
- **组选择**：`fallback`（按序取第一个健康节点）与 `url-test`（取延迟最低的健康节点），
  无健康数据时回落首位候选。
- **健康检查**：池的出站为 `pool` 时周期经每节点拨号探测（间隔/超时可配），结果记入
  `ProxyHealth` 并以 `node-health` 事件发布；`checkNode` 也可手动触发。
- **生命周期**：`ctx.effect` 持有入站监听、后台定时器与活跃连接表；fiber 释放或池
  出站切到直连/自定义代理时全部停止，不留悬挂定时器与进行中的后台刷新排期。

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
// 池的出站由 `proxy-pool` 设置分节驱动；直连时 proxyURL 返回 undefined。
pool.outbound // { mode: 'direct' | 'pool' | 'custom', customUrl?: string }
const dispose = pool.registerNode(parseProxyLink('socks5://1.2.3.4:1080#node-a'))
pool.registerGroup({ id: 'g', name: '主组', members: ['<node-a-id>'], strategy: 'fallback' })
pool.useGroup('g')
const url = pool.proxyURL({ kind: 'pool' }) // http://127.0.0.1:<port>
```

消费方拿到的 `url` 直接喂给 undici `ProxyAgent` 即可；`proxyURL({ kind: 'direct' })`
返回 `undefined` 表示直连。

## 共享出站契约

渠道级出站选择（直连／内置代理池／自定义代理）不归池保管，也不在各消费方里各写
一份：`coding-proxy-pool` 通过 `OutboundConfig` / `OutboundConfigSchema` /
`toProxyMode` / `resolveOutboundURL` 导出一份共享契约，模型渠道（`llm-deepseek`、
`llm-opencode`）与联网搜索提供方（`web-search-*`）都在自己的设置分节里保存这份
选择，请求期用它解析地址。

- **选择与规则分开**：消费方选 `pool` 表示「按池自己的出站规则」——池规则为直连
  时 `resolveOutboundURL` 返回 `undefined`（消费方回落直连），池规则为自定义代理
  时返回池配置的地址，池规则为本地池时返回本地入站地址。
- **`custom` 不受池规则影响**：消费方选 `custom` 时只用它自己保存的 http(s) 地址，
  即使池正在运行别的出站规则也一样；缺合法地址时抛错（错误信息为
  `custom outbound requires an http(s) proxy URL`，消费方在自身诊断里点名配置项）。
- **池缺席回落直连**：`resolveOutboundURL(undefined, config)` 在 `direct` 与 `pool`
  两种选择下都返回 `undefined`，`custom` 仍返回消费方自己的地址（它不依赖池）；池服务
  是可选依赖，未装配不阻断消费方请求。

```ts
import { resolveOutboundURL } from 'coding-proxy-pool'

// 消费方请求期：池是可选服务，缺席即直连。
const url = resolveOutboundURL(ctx.get('proxyPool'), outbound ?? { mode: 'direct' })
const dispatcher = url === undefined ? undefined : new ProxyAgent(url)
```

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
- **节点凭据是明文链接行**：持久化分节按分享链接原文（含凭据）存放在本机
  设置文档里；接入凭据存储前由设置层决定是否加密。
- **Free 渠道并发请求共享全局 dispatcher**：`llm-opencode` 的出站切换按请求替换
  undici 全局 dispatcher；两个真正并发的代理请求会互相覆盖，Free 渠道的串行请求模式
  不受影响，见 `llm-opencode/src/outbound.ts` 的说明。DeepSeek 渠道改为逐请求注入
  dispatcher，不受此限制。
