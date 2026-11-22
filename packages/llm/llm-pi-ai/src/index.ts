/**
 * Generic pi-ai-backed LLM adapter plugin. One plugin instance owns a dict of
 * provider routes; a route naming an installed pi-ai provider inherits that
 * provider's endpoint, protocol, and model catalog as defaults, and a route
 * pi-ai does not ship is declared outright. Profile facts resolve per request
 * over the optional `llm-pi-ai` user-settings section and the optional
 * credential seam, so a changed key, endpoint, model, or knob reaches the next
 * request without a restart; a changed *route set* (or a route's
 * registration-captured retry policy) re-registers the same adapter instance
 * in place.
 *
 * ```yaml
 * - id: llm
 *   name: 'coding-llm-pi-ai'
 *   config:
 *     providers:
 *       # Catalog route: everything but the credential comes from pi-ai.
 *       openai:
 *         apiKeyEnv: OPENAI_API_KEY
 *         retryPolicy:
 *           mode: normal
 *           maxRetries: 2
 *       # Catalog route with the catalog narrowed and one capacity corrected.
 *       anthropic:
 *         apiKeyEnv: ANTHROPIC_API_KEY
 *         models:
 *           - id: claude-sonnet-4-5
 *             contextWindow: 200000
 *       # Hand-declared route: pi-ai ships nothing under this key.
 *       acme-gateway:
 *         displayName: Acme Gateway
 *         apiKeyEnv: ACME_GATEWAY_API_KEY
 *         api: openai-completions
 *         baseURL: https://gateway.acme.example/v1
 *         # Reasoning dialect for a URL pi-ai cannot recognize.
 *         compat:
 *           thinkingFormat: deepseek
 *         models:
 *           - id: acme-large
 *             name: Acme Large
 *             contextWindow: 65536
 *             maxTokens: 4096
 *           - id: acme-think
 *             name: Acme Think
 *             contextWindow: 262144
 *             maxTokens: 32768
 *             # key = selectable level, value = wire spelling; only off may
 *             # leave the value empty (supported, send nothing).
 *             reasoningEfforts:
 *               off:
 *               high: high
 *               max: ultra
 * ```
 *
 * @module coding-llm-pi-ai
 */

import type { Context } from '@deepseek-ai/cordis'
import { launchEnvironmentOf } from 'coding-launch-environment'
import { assertUsableApiKey, LlmError, resolveUserAgent } from 'coding-llm'
import type { LlmConfigurableProvider } from 'coding-llm'
import { installSettingsSection, settingsNamespace } from 'coding-settings'
import { PiAiAdapter } from './adapter.ts'
import { registerChannels } from './channel-registry.ts'
import { catalogModels, catalogProvider, catalogProviderIds, catalogProviderTakesApiKey } from './catalog.ts'
import { assertServiceable, Config, resolveProfiles } from './config.ts'
import type { ResolvedPiAiProviderProfile } from './config.ts'
import { discoverModels } from './discovery.ts'
import { outboundFetch } from './outbound.ts'

export { PiAiAdapter } from './adapter.ts'
export type { PiAiAdapterOptions } from './adapter.ts'
export { Config } from './config.ts'
export type {
  PiAiCompatProfile,
  PiAiModality,
  PiAiModelOverride,
  PiAiModelProfile,
  PiAiProviderProfile,
  PiAiReasoningEfforts,
  PiAiThinkingFormat,
  ResolvedPiAiProviderProfile,
} from './config.ts'
export { configuredProtocolStreams, supportedProtocols } from './provider.ts'
export type { ConfiguredProtocol } from './provider.ts'
export { streamPiAiRequest } from './stream-request.ts'
export type { PiAiStreamRequest } from './stream-request.ts'
export { streamChannelRequest } from './channel-stream.ts'
export { queryModelListing } from './discovery.ts'
export { registerChannels } from './channel-registry.ts'

export const name = 'llm-pi-ai'
export const inject = ['llm']

const NS = settingsNamespace('llm-pi-ai')

/**
 * The configurable-provider directory: every installed catalog route this
 * adapter can authenticate, plus every route the current profiles declare. A
 * hand-declared route has no catalog entry, so without this union it would
 * have no settings address and configuration surfaces could neither show nor
 * edit it.
 *
 * The profile half is unconditional, which is what keeps a route already
 * stored against a withheld provider editable and deletable rather than
 * stranded in the settings document with nothing on the page to remove it.
 * @param profiles - the currently resolved provider profiles.
 * @returns the directory entries in catalog order, declared routes last.
 */
function directoryEntries(
  profiles: ReadonlyMap<string, ResolvedPiAiProviderProfile>,
): LlmConfigurableProvider[] {
  const catalog = new Set(catalogProviderIds())
  const entries = new Map<string, LlmConfigurableProvider>()
  const declare = (provider: string, displayName: string): void => {
    entries.set(provider, {
      provider,
      displayName,
      settingsNs: NS,
      settingsPath: ['providers', provider],
      // Membership of the installed catalog, not of the settings document:
      // narrowing a shipped provider's models stores a profile too, and that
      // route is still one pi-ai knows.
      declared: !catalog.has(provider),
    })
  }
  // A provider whose only native method is OAuth leaves this adapter nothing
  // to authenticate with, so offering it would put a card on the settings page
  // whose own posture — no key, credentials discovered by the provider — fails
  // every request. Catalog *membership* is unaffected, so `declare` above still
  // answers what pi-ai ships.
  for (const provider of catalog) {
    if (catalogProviderTakesApiKey(provider)) declare(provider, provider)
  }
  for (const [provider, profile] of profiles) declare(provider, profile.displayName)
  return [...entries.values()]
}

/** Register one generic pi-ai adapter for all configured provider routes. */
export function apply(ctx: Context, config: Config): void {
  let current: () => Config = () => config
  let lastRaw: Config | undefined
  let memoized: ReadonlyMap<string, ResolvedPiAiProviderProfile> | undefined
  /**
   * The resolved profiles for the current configuration, memoized by the raw
   * snapshot's identity — which is also what makes the adapter's own snapshot
   * stable across operations that observe no change.
   *
   * No fallback for an unserviceable snapshot lives here: the section schema
   * resolves the whole profile set, so a write that could not be served is
   * refused where it is written, and the settings seam keeps a namespace's
   * last good value for a stored section that fails. Anything reaching this
   * point has already resolved once.
   */
  const profiles = (): ReadonlyMap<string, ResolvedPiAiProviderProfile> => {
    const raw = current()
    if (raw === lastRaw && memoized !== undefined) return memoized
    const next = resolveProfiles(raw.providers)
    lastRaw = raw
    memoized = next
    return next
  }
  profiles()

  const resolveApiKey = async (
    provider: string,
    profile: ResolvedPiAiProviderProfile,
  ): Promise<string | undefined> => {
    const ref = profile.apiKeyEnv
    // Only a profile that names no credential at all defers to pi-ai's
    // provider-native discovery. Once one is named, a miss must fail loud:
    // handing pi-ai `undefined` would let it pick up an unrelated ambient key
    // (OPENAI_API_KEY and friends), billing another tenant for a request the
    // deployment meant to authenticate differently.
    if (ref === undefined) return undefined
    const credentials = ctx.get('credentials')
    const hit = credentials !== undefined
      ? (await credentials.resolve(ref))?.value
      // Without the seam the environment is the whole credential plane.
      : launchEnvironmentOf(ctx).get(ref)?.value
    if (hit !== undefined && hit.length > 0) return assertUsableApiKey(hit, 'llm-pi-ai', ref)
    throw new LlmError(
      `llm-pi-ai: no credential for provider route "${provider}"; its profile resolves ${ref}, which is not`
      + ` set — store ${ref} through the credentials service (the web Models page writes it) or export it,`
      + ' and remove apiKeyEnv only if this provider should authenticate from pi-ai\'s own environment discovery',
      'MISSING_CREDENTIAL',
    )
  }

  const adapter = new PiAiAdapter({
    profiles,
    resolveApiKey,
    resolveAttachments: () => ctx.get('attachments'),
    resolveProxyPool: () => ctx.get('proxyPool'),
    onReplayDegrade: ({ provider, model, reason }) => {
      ctx.logger.warn(
        `llm-pi-ai: unusable replay state on assistant history for route "${provider}/${model}";`
        + ` sending that message as provider-neutral content (${reason})`,
      )
    },
  })
  const refreshChannels = registerChannels(ctx, adapter, () => {
    const currentProfiles = profiles()
    return { entries: directoryEntries(currentProfiles), routes: [...currentProfiles.keys()] }
  })
  /** 已保存路由提供端点与协议；凭据只在查询确认端点相同后才解析。 */
  const storedRoute = (provider: string | undefined) => {
    if (provider === undefined) return undefined
    const profile = profiles().get(provider)
    const baseURL = profile?.piProvider.baseUrl ?? catalogProvider(provider)?.baseUrl
    if (baseURL === undefined) return undefined
    const api = profile?.api ?? profile?.piProvider.getModels()[0]?.api
      ?? catalogModels(provider).values().next().value?.api
    return {
      baseURL,
      ...api === undefined ? {} : { api },
      userAgent: resolveUserAgent(profile?.userAgent),
      requestFetch: () => profile === undefined ? undefined : outboundFetch(
        provider,
        profile.outbound,
        profile.outbound.mode === 'pool' ? ctx.get('proxyPool') : undefined,
      ),
      hasStoredKey: profile?.apiKeyEnv !== undefined,
      apiKey: () => profile === undefined ? Promise.resolve(undefined) : resolveApiKey(provider, profile),
    }
  }
  // 新建路由尚未注册，因此查询面向整个 namespace；草稿密钥不进入设置存储。
  ctx.llm.registerModelDiscovery(NS, request => discoverModels(request, () => storedRoute(request.provider)))
  installSettingsSection(ctx, NS, Config, config, {
    // 无法服务的配置在写入时拒绝，不撤掉已可用的路由。
    validate: assertServiceable,
    setSource: (source) => {
      current = source
    },
    onChange: refreshChannels,
  })
}
