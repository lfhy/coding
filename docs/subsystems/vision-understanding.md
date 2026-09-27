# 视觉理解降级

[`llm-vision-fallback`](../../packages/llm/llm-vision-fallback/README.md) 在主请求确认模型后检查其输入模态。明确不支持图片的模型只有在 `vision-understanding` 设置中显式选择一条已配置且声明支持图片的模型路由后，才能处理含图片的会话。未配置或视觉调用失败时不会发送主模型请求；输入能力未知的主模型仍由原适配器判断。

## 请求与记录

视觉路由对每张图片只接收该图片的附件引用和固定描述提示词，不接收整段会话历史或工具。辅助调用前写入仅记日志的 `vision/request`，包含精确路由、提示词、附件引用与输出限制；成功的 `vision/description` 关联请求并保存有界纯文本。两者不存图片字节。随后单节点替换当前模型可见 surface 中的图片块，原始用户或工具结果事件保留供界面、附件读取和回放。主请求从替换后的持久 surface 重建；已完成的描述不会在下一步重复调用。

`agent/request-history` 位于确切模型解析之后、`deriveMessages()` 之前。监听器必须调用 `next()`；取消、超限、无终止分片、非纯文本输出或任何描述失败都会阻止主请求。一次请求先完成全部描述再开始写替换；跨多个节点的提交不是单个事务，若中途持久化失败，已完成节点保持可重建，重试只处理仍含图片的节点。

事件载荷见持久化目录中的[`vision/request`](../persistence-catalog.md#visionrequest--log-only)与[`vision/description`](../persistence-catalog.md#visiondescription--log-only)；配置字段见[配置目录](../config-catalog.md#deepseek-aidsh-llm-vision-fallback)。

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog`; regenerate with `pnpm run gen-cordis-catalog`) — this section is byte-identical in both language sides of the page. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxvisionunderstanding--visionunderstanding"></a>

### `ctx.visionUnderstanding` — `VisionUnderstanding`

请求前降级服务；Host 可同步读取显式配置状态。

```ts cordis-catalog
/**
 * 返回路由是否由设置或组合显式、完整地指定；不代表凭据和模型可用。
 * @returns 供 Host 提前把有图片的文本模型请求判为可尝试的状态。
 */
status(): { configured: boolean; provider?: string; model?: string }

/**
 * 只在主模型没有图片输入能力且 surface 含图片时生成描述；失败不会委托主模型。
 * @param session - 请求所属的持久会话。
 * @param target - 本次主请求的精确模型路由。
 * @param inputModalities - 与主请求同一次解析的能力；缺席视为未知且不触发降级。
 * @param signal - agent 的轮次取消信号。
 * @returns 全部替换写入并通过持久化检查点后结算。
 */
async prepareHistory( session: Session, target: LlmCallConfig, inputModalities: readonly string[] | undefined, signal: AbortSignal, ): Promise<void>
```

Types: [LlmCallConfig](llm-streaming.md) · [Session](session.md)

Source: [`packages/llm/llm-vision-fallback/src/index.ts:216`](../../packages/llm/llm-vision-fallback/src/index.ts)
<!-- END GENERATED cordis-surface -->
