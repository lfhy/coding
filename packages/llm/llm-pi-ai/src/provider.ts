/**
 * Construction of the pi-ai `Provider` that one configured route registers into
 * the adapter's `Models` collection.
 *
 * 目录渠道保留原提供方的协议实现；其新增协议由单独的 pi-ai 实现承接。
 * 自定义渠道或显式改写整条渠道协议时，按模型协议构造提供方。
 *
 * Credentials never reach this module's storage: the harness resolves a route's
 * key through `ctx.credentials` before the request enters pi-ai and hands it
 * over as a stream option, which `Models` presents to `resolve()` as the
 * credential key.
 *
 * @module dsh-llm-pi-ai/provider
 */

import { createProvider } from '@earendil-works/pi-ai'
import type { Api, ApiKeyAuth, Model, Provider, ProviderStreams } from '@earendil-works/pi-ai'
import { anthropicMessagesApi } from '@earendil-works/pi-ai/api/anthropic-messages.lazy'
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy'
import { openAIResponsesApi } from '@earendil-works/pi-ai/api/openai-responses.lazy'
import { catalogProvider } from './catalog.ts'

/**
 * Wire protocols a configured route may name, mapped to pi-ai's lazily loaded
 * implementations. Each entry is the factory that pi-ai's matching provider
 * factory uses, so a hand-declared route reaches exactly the implementation a
 * catalog route would.
 *
 * The table is deliberately narrow: the protocols a hand-declared route
 * actually reaches for today, each completely describable with a key, an
 * endpoint, and headers. Bedrock signs with SigV4 over AWS credentials and a
 * region, Vertex needs a project, a location, and application-default
 * credentials, Azure needs provider environment plus an api-version, and Codex
 * authenticates through OAuth — none of which this configuration shape can
 * express, so offering them would hand back a provider that cannot
 * authenticate. The remainder are absent for want of a consumer rather than a
 * blocker: each is one line here once a deployment needs it. Catalog routes
 * still reach every protocol through their own provider; only an explicit
 * override is refused.
 */
const PROTOCOLS = {
  'openai-completions': openAICompletionsApi,
  'openai-responses': openAIResponsesApi,
  'anthropic-messages': anthropicMessagesApi,
} satisfies Record<string, () => ProviderStreams>

/** 仅用端点和 API 密钥就能显式配置的协议。 */
export type ConfiguredProtocol = keyof typeof PROTOCOLS

/**
 * 设置 schema 和渠道表单使用同一份显式协议列表。
 * @returns 支持的协议标识，OpenAI Chat Completions 排在首位。
 */
export function supportedProtocols(): readonly ConfiguredProtocol[] {
  return Object.keys(PROTOCOLS) as ConfiguredProtocol[]
}

/**
 * 创建已知协议的惰性请求实现，不加载提供方目录或解析凭据。
 * @param api - 调用方已校验的协议。
 * @returns 该协议的流请求入口。
 */
export function configuredProtocolStreams(api: ConfiguredProtocol): ProviderStreams {
  return PROTOCOLS[api]()
}

/** @param api - 模型的协议标识。 @returns 是否有独立构造的 HTTP 协议实现。 */
export function isConfiguredProtocol(api: string): api is ConfiguredProtocol {
  return Object.hasOwn(PROTOCOLS, api)
}

/**
 * Api-key auth for a route the harness authenticates itself. `Models` calls
 * this after the adapter has already resolved the route's credential, so a
 * missing key here is not this layer's failure: a named-but-unresolvable
 * reference has already failed the request with `MISSING_CREDENTIAL`, and a
 * route naming no credential at all is deliberately unauthenticated. Reporting
 * it as configured hands the decision to the protocol, which is where the
 * requirement actually lives — pi-ai's OpenAI-compatible implementation, for
 * one, still insists on a key or an `Authorization` header of its own.
 * @param name - display name used as the resolution's status label.
 * @returns the api-key auth for a harness-authenticated route.
 */
function harnessApiKeyAuth(name: string): ApiKeyAuth {
  return {
    name,
    resolve: ({ credential }) => Promise.resolve({
      auth: credential?.key === undefined ? {} : { apiKey: credential.key },
      source: name,
    }),
  }
}

/** The resolved route facts provider construction reads. */
export interface ProviderSpec {
  /** Provider route key; also the `Models` collection key and each model's `provider`. */
  provider: string
  /** Display name for selectors and status labels. */
  displayName: string
  /** 渠道协议覆盖；模型自身的协议选择仍优先。 */
  api?: string
  /** Endpoint override already applied to {@link models}; kept for provider-level display. */
  baseURL?: string
  /** The route's materialized models, in configuration order. */
  models: readonly Model<Api>[]
  /**
   * Whether the profile names a credential, which it does through `apiKeyEnv`
   * alone: configuration carries the reference, never the secret. Only that
   * decides whether {@link routeAuth} adds the harness's own api-key method to
   * a catalog provider that offers none; the key itself still arrives per
   * request, never at construction.
   */
  namesCredential: boolean
  /** 代理渠道只使用经过验证的 HTTP 协议实现与不会联网的认证解析。 */
  requireFetchTransport?: boolean
}

/**
 * The auth one route resolves its credential through.
 *
 * A catalog route keeps the installed provider's own auth, which is what
 * preserves provider-native ambient discovery for a profile naming no
 * credential. That holds even when the profile repoints the protocol: which
 * environment a provider reads is a property of the provider, not of the wire
 * format its models speak.
 *
 * The single addition covers a catalog provider that offers no api-key method
 * at all. pi-ai resolves a request's `apiKey` override only when the provider
 * declares one (`resolveProviderAuth` checks `provider.auth.apiKey` before
 * honouring the override), so an OAuth-only provider — `openai-codex` is the
 * one the installed catalog ships — would refuse a profile's explicit key with
 * `Provider is not configured` before any request went out. Adding the harness
 * method beside the provider's own restores that route. A keyless profile adds
 * nothing and still reports the honest refusal, because this adapter resolves
 * credentials through its own seam and holds no OAuth store to fall back on.
 * @param spec - the resolved route facts.
 * @param catalog - the installed catalog provider, when pi-ai ships one.
 * @returns the auth to construct this route's provider with.
 */
function routeAuth(spec: ProviderSpec, catalog: Provider | undefined): Provider['auth'] {
  if (catalog === undefined || spec.requireFetchTransport === true) {
    return { apiKey: harnessApiKeyAuth(spec.displayName) }
  }
  if (catalog.auth.apiKey !== undefined || !spec.namesCredential) return catalog.auth
  return { ...catalog.auth, apiKey: harnessApiKeyAuth(spec.displayName) }
}

/**
 * Reuse an installed catalog provider with this route's models and identity.
 * Model dispatch stays with the catalog provider, so its API implementations,
 * compatibility quirks, and ambient credential discovery are preserved exactly.
 * Catalog-owned dynamic refresh is dropped: this route's catalog is the
 * settings document, and a background refresh would contradict it.
 */
function reuseCatalogProvider(base: Provider, spec: ProviderSpec): Provider {
  // Provider-level `baseUrl` is display metadata: pi-ai routes every request
  // through `Model.baseUrl`, which model resolution has already overridden.
  const baseUrl = spec.baseURL ?? base.baseUrl
  return {
    id: spec.provider,
    name: spec.displayName,
    ...baseUrl === undefined ? {} : { baseUrl },
    auth: routeAuth(spec, base),
    getModels: () => spec.models,
    // Delegated rather than copied: the catalog provider stays the receiver, so
    // an implementation holding state on itself keeps working.
    stream: (model, context, options) => base.stream(model, context, options),
    streamSimple: (model, context, options) => base.streamSimple(model, context, options),
  }
}

/**
 * 按模型协议构建请求实现；目录渠道保留原生实现，只有新增的协议走显式工厂。
 * @param spec - 已解析的渠道与模型。
 * @returns 注册到适配器模型集合的提供方。
 * @throws Error 显式协议没有可用的请求实现时抛出。
 */
export function buildProvider(spec: ProviderSpec): Provider {
  const catalog = catalogProvider(spec.provider)
  if (spec.api !== undefined && !isConfiguredProtocol(spec.api)) {
    throw new Error(
      `llm-pi-ai: provider "${spec.provider}" names api "${spec.api}", which this build cannot serve;`
      + ` supported protocols are ${supportedProtocols().join(', ')}`,
    )
  }

  const nativeApis = catalog === undefined || spec.api !== undefined || spec.requireFetchTransport === true
    ? new Set<string>()
    : new Set(catalog.getModels().map(model => model.api))
  const delegated = spec.models.filter(model => !nativeApis.has(model.api))
  if (catalog === undefined && delegated.length === 0) {
    throw new Error(
      `llm-pi-ai: provider "${spec.provider}" names api "${spec.api}", which this build cannot serve;`
      + ` supported protocols are ${supportedProtocols().join(', ')}`,
    )
  }
  if (delegated.length === 0 && catalog !== undefined) return reuseCatalogProvider(catalog, spec)

  const streams: Record<string, ProviderStreams> = {}
  for (const model of delegated) {
    if (!isConfiguredProtocol(model.api)) {
      if (spec.requireFetchTransport === true) {
        throw new Error(
          `llm-pi-ai: provider "${spec.provider}" model "${model.id}" uses api "${model.api}",`
          + ` which cannot use outbound proxies; use direct outbound or ${supportedProtocols().join(', ')}`,
        )
      }
      throw new Error(
        `llm-pi-ai: provider "${spec.provider}" model "${model.id}" names api "${model.api}",`
        + ` which this build cannot serve; supported protocols are ${supportedProtocols().join(', ')}`,
      )
    }
    streams[model.api] ??= configuredProtocolStreams(model.api)
  }
  const auth = routeAuth(spec, catalog)
  const custom = createProvider({
    id: spec.provider,
    name: spec.displayName,
    ...spec.baseURL === undefined ? {} : { baseUrl: spec.baseURL },
    auth,
    models: delegated,
    api: streams,
  })
  if (catalog === undefined || spec.api !== undefined || spec.requireFetchTransport === true) return custom

  // 目录提供方可能包含无法仅凭密钥重建的原生协议；只替换其目录没有的协议。
  const native = reuseCatalogProvider(catalog, spec)
  const delegatedIds = new Set(delegated.map(model => model.id))
  return {
    ...native,
    stream: (model, context, options) => delegatedIds.has(model.id)
      ? custom.stream(model, context, options)
      : native.stream(model, context, options),
    streamSimple: (model, context, options) => delegatedIds.has(model.id)
      ? custom.streamSimple(model, context, options)
      : native.streamSimple(model, context, options),
  }
}
