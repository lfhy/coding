# 代理池

[`coding-proxy-pool`](../../packages/net/proxy-pool/README.md) 提供 `ctx.proxyPool`，把节点注册、健康检查、订阅刷新和本地 HTTP 代理入站组合成可选的出站能力。

代理池自己的 `proxy-pool` 设置分节决定直连、池转发或自定义代理；模型渠道和联网搜索提供方在各自设置中保存出站选择，并在请求期向该服务解析地址。Host API 只负责节点、组、健康状态和出站设置的管理调用。

服务只监听回环地址，随宿主 fiber 启停入站和后台任务；直连或自定义代理不启动健康检查与周期刷新，池转发才启动这些任务。代理节点凭据保存在本机设置中，代理路径变化不产生模型可见内容。

服务方法的完整签名、事件和 JSDoc 由下方 Cordis API 区域生成。

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog`; regenerate with `pnpm run gen-cordis-catalog`) — this section is byte-identical in both language sides of the page. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxproxypool--proxypoolservice"></a>

### `ctx.proxyPool` — `ProxyPoolService`

代理池服务。一个实例伴随宿主存活：构造后启动本地 HTTP 入站，fiber 释放时 停止监听与后台循环，不留下端口或悬挂定时器。

池规则（`proxy-pool` 设置分节的 `mode`）决定后台是否工作：`direct` 时既 不探测节点也不拉订阅，`proxyURL({ kind: 'pool' })` 返回 undefined，消费方 据此回落直连；`pool` 时才启动健康检查与周期刷新。

```ts cordis-catalog
/** 等待本地入站完成监听；服务已停止时立即返回。 */
async ready(): Promise<void>

/**
 * 注册一个节点；重复 id 抛 `PROXY_NODE_DUPLICATE`。
 * @param node - 节点描述符。
 * @returns 注销该节点的 disposer。
 */
registerNode(node: ProxyNode): () => void

/**
 * 原地改节点显示名：订阅刷新把探测通过的候选改成 `feed:` 前缀时使用，
 * id 与健康记录保持不变（重注册会两者皆失）。
 * @param nodeId - 节点 id。
 * @param name - 新显示名。
 */
renameNode(nodeId: string, name: string): void

/**
 * 按注销一个节点；未知 id 返回 false。管理面（RPC `proxyPool.removeNode`）
 * 与设置持久化的重放都用它，不需要先取出描述符再注册取 disposer。
 * @param nodeId - 节点 id。
 * @returns 节点存在并被移除时为 true。
 */
unregisterNode(nodeId: string): boolean

/**
 * 注册一个连接组；成员必须已注册或随后注册。
 * @param group - 组描述符。
 * @returns 注销该组的 disposer。
 */
registerGroup(group: ProxyGroup): () => void

/** 当前全部节点的快照。
 * @returns 按注册顺序排列的节点描述符副本。
 */
listNodes(): ProxyNode[]

/** 当前全部组的快照。
 * @returns 按注册顺序排列的连接组描述符副本。
 */
listGroups(): ProxyGroup[]

/** 节点健康快照。
 * @returns 按最近写入顺序排列的健康状态副本。
 */
snapshotHealth(): ProxyHealth[]

/**
 * 按出站模式解析出 undici 可用的代理 URL。
 *
 * 渠道选择「内置代理池」时使用池自己的出站控制：直连规则返回 undefined
 * （消费方回落直连），自定义代理规则返回池配置的地址，本地池规则返回入站地址。
 * 渠道自己的自定义代理不受池规则影响。
 * @param mode - 消费方声明的出站模式。
 * @returns 可注入 ProxyAgent 的地址，或直连时的 undefined。
 */
proxyURL(mode: ProxyMode): string | undefined

/**
 * 设置入站使用的组；未设置或组不存在时按 fallback 全池选择。
 * @param groupId - 组 id 或 undefined。
 */
useGroup(groupId: string | undefined): void

/** 对全部节点执行一轮健康检查并发事件。 */
async checkAll(): Promise<void>

/**
 * 触发一次订阅刷新（手动与周期共用；进行中时复用同一个 Promise）。
 * 失败不抛出——摘要里的 `failures` 承载每个源的错误，管理面据此展示。
 * @returns 本次刷新的摘要。
 */
async refresh(): Promise<RefreshResult>

/**
 * 探测单个节点：经该节点拨号到公网目标并立即关闭。
 * @param nodeId - 节点 id。
 * @param timeoutMs - 本次探测的超时；缺省用健康检查配置的值（订阅刷新
 *   用更紧的值轮询海量候选，避免单个死节点占满探测窗口）。
 * @returns 节点仍注册时返回健康快照；节点不存在时返回 `undefined`。
 */
async checkNode(nodeId: string, timeoutMs?: number): Promise<ProxyHealth | undefined>
```

Source: [`packages/net/proxy-pool/src/index.ts:137`](../../packages/net/proxy-pool/src/index.ts)

<a id="proxy-pool-events"></a>

### `proxy-pool/*` events

<a id="proxy-poolnode--emit"></a>

#### `proxy-pool/node` — emit

节点级事件：新增/更新/移除/健康变化。监听方（代理池管理页）据此刷新 展示；事件在状态已提交后同步派发。

```ts cordis-catalog
/**
 * 节点级事件：新增/更新/移除/健康变化。监听方（代理池管理页）据此刷新
 * 展示；事件在状态已提交后同步派发。
 * @param event - 已提交的节点变化事件。
 * @mode emit
 */
'proxy-pool/node'(event: ProxyPoolNodeEvent): void
```

Source: [`packages/net/proxy-pool/src/index.ts:95`](../../packages/net/proxy-pool/src/index.ts)
<!-- END GENERATED cordis-surface -->
