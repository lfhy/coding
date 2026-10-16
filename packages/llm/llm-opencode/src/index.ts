/**
 * 内置 OpenCode Zen 免费渠道插件：把 [OpenCode Zen](https://opencode.ai/zen) 的匿名
 * 免费模型注册成 harness 的一个原生 LLM 提供方路由（默认 `opencode-zen`）。
 *
 * 开箱即用：不挂载任何设置分节时，插件使用内置端点、匿名凭据 `public` 与三个
 * 免费模型。请求与官方 OpenCode CLI 同形——同一个 User-Agent、同一套按会话派生的
 * 关联头、同一个工具形状门——因此无需登录、无需注册即可使用该通道。
 *
 * ```yaml
 * - id: llm-opencode
 *   name: '@deepseek-ai/dsh-llm-opencode'
 *   config:
 *     # 全部可省略；下面的写法与省略等价。
 *     channelName: OpenCode Zen
 *     apiKey: public
 *     baseURL: https://opencode.ai/zen/v1
 *     models:
 *       - id: mimo-v2.6-flash-free
 *         name: Mimo V2.6 Flash
 *         contextWindow: 1048576
 * ```
 *
 * 用户可以在设置页改端点、渠道名称、换成自己的 key，或增删模型；改动在下一次
 * 请求生效，不需要重启。该路由同时声明在可配置提供方目录里，因此**设置 → 模型**
 * 直接列出这条渠道，无需先在 `settings.yaml` 里写分节。
 *
 * @module @deepseek-ai/dsh-llm-opencode
 */

import type { Context } from '@deepseek-ai/cordis'
import { installSettingsSection, settingsNamespace } from '@deepseek-ai/dsh-settings'
import { OpencodeZenAdapter } from './adapter.ts'
import { Config, DEFAULT_CHANNEL_NAME, PROVIDER_ID, resolveOpencodeOptions } from './config.ts'
import type { ResolvedOpencodeOptions } from './config.ts'

export { OpencodeZenAdapter } from './adapter.ts'
export type { OpencodeZenAdapterOptions } from './adapter.ts'
export {
  Config,
  DEFAULT_API_KEY,
  DEFAULT_MAX_REQUEST_IMAGE_BYTES,
  DEFAULT_STREAM_IDLE_TIMEOUT_MS,
  DEFAULT_BASE_URL,
  DEFAULT_CHANNEL_NAME,
  DEFAULT_MODELS,
  PROVIDER_ID,
  resolveOpencodeOptions,
} from './config.ts'
export type { OpencodeModelConfig, ResolvedOpencodeModel, ResolvedOpencodeOptions } from './config.ts'
export { disguiseHeaders, deriveRequestIds, opencodeUserAgent } from './ids.ts'
export { ensureFreeLaneShape, FREE_LANE_GATE_TOOL_NAMES } from './free-lane.ts'

/** Cordis 插件名。 */
export const name = 'llm-opencode'
/** LLM 注册表是本插件唯一必需的服务。 */
export const inject = ['llm']

/** 本插件拥有的设置 namespace。 */
const NS = settingsNamespace('llm-opencode')

/**
 * 注册内置渠道。连接事实按每次操作解析一次，因此设置变更即刻生效；
 * 路由本身是注册级事实，只在插件卸载时撤销。
 * @param ctx - 持有适配器注册生命周期的插件上下文。
 * @param config - 作为设置基础层的组合配置；设置分节覆盖它。
 * @returns 无返回值。
 */
export function apply(ctx: Context, config: Config): void {
  let current: () => Config = () => config
  let lastRaw: Config | undefined
  let lastGood: ResolvedOpencodeOptions | undefined
  const options = (): ResolvedOpencodeOptions => {
    const raw = current()
    if (raw === lastRaw && lastGood !== undefined) return lastGood
    try {
      const next = resolveOpencodeOptions(raw)
      lastRaw = raw
      lastGood = next
      return next
    } catch (error) {
      // 组合配置在注册前就已解析，因此这里只可能是运行中的设置快照越过 schema 之外
      // 的约束：保留上一份可用事实并说明一次，而不是让每次请求都抛错。
      if (lastGood === undefined) throw error
      lastRaw = raw
      ctx.logger.error('llm-opencode: keeping the last good configuration after an invalid settings section')
      ctx.logger.error(error)
      return lastGood
    }
  }
  options()

  const adapter = new OpencodeZenAdapter({
    options,
    resolveUserAgent: () => ctx.llm.getUserAgent(),
    resolveAttachments: () => ctx.get('attachments'),
  })
  const registration = ctx.llm.registerAdapter([PROVIDER_ID], adapter)

  // 本路由自带可用的默认端点、匿名凭据与目录，因此它在设置页里是一条已配置的
  // 可编辑渠道：整节即 profile，名称跟随生效设置。注册表会捕获渠道名称，因此
  // 名称变化时原地替换路由与目录条目，保留同一条路由与卸载时的清理责任。
  let registeredName = current().channelName ?? DEFAULT_CHANNEL_NAME
  const directory = ctx.llm.registerConfigurableProviders([
    { provider: PROVIDER_ID, displayName: registeredName, settingsNs: NS, settingsPath: [] },
  ])
  const ensureRegistrationFacts = (): void => {
    const displayName = current().channelName ?? DEFAULT_CHANNEL_NAME
    if (displayName === registeredName) return
    registration.replace([PROVIDER_ID])
    directory.replace([{ provider: PROVIDER_ID, displayName, settingsNs: NS, settingsPath: [] }])
    registeredName = displayName
  }

  installSettingsSection(ctx, NS, Config, config, {
    setSource: (source) => { current = source },
    // 消费者每次操作都经 options() 读取连接事实，因此设置变化只需要同步注册级名称。
    onChange: () => { ensureRegistrationFacts() },
  })
}
