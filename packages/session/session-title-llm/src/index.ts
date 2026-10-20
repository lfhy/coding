/**
 * Shared route, framing, timeout, assembly, and validation policy for
 * model-backed session-title providers.
 * @module coding-session-title-llm
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { createUserMessage, BlockAssembler, deepFreeze } from 'coding-llm'
import type { FinishReason, GenerateOptions, Message } from 'coding-llm'
import { installSettingsSection, settingsNamespace } from 'coding-settings'
import { deadline, MAX_TIMER_DELAY_MS } from 'coding-timeout'
import {
  normalizeSessionTitle,
  SessionTitleProviderId,
} from 'coding-session-title'
import type {
  SessionTitleAutomaticMode,
  SessionTitleModelProvenance,
  SessionTitleProviderRequest,
  SessionTitleProviderResult,
  SessionTitleUserMessage,
} from 'coding-session-title'

/** Exact model-visible request recorded before one auxiliary title dispatch. */
export interface SessionTitleLlmRequestEventData {
  /** Registered title-provider identity responsible for the request. */
  readonly titleProvider: SessionTitleProviderId
  /** Exact human `user/message` seqs represented in `messages`. */
  readonly messageSeqs: number[]
  /** Exact auxiliary LLM route. */
  readonly route: SessionTitleModelProvenance
  /** Exact auxiliary system prompt. */
  readonly system: string
  /** Exact auxiliary message list. */
  readonly messages: Message[]
  /** Exact auxiliary output-token cap. */
  readonly maxTokens: number
}

declare module 'coding-session/types' {
  interface SessionEventMap {
    /** Log-only pre-dispatch record of one session-title model request. */
    'session/title-llm-request': SessionTitleLlmRequestEventData
  }
}

/** Capability-owned timeout reason code for auxiliary title requests. */
export const SESSION_TITLE_TIMEOUT_CODE = 'SESSION_TITLE_TIMEOUT'

/**
 * 会话标题生成模型的三种模式。
 *
 * - `inherit`：沿用会话已记录的主请求路由，标题与对话消耗同一个模型。
 * - `custom`：使用设置里单独指定的标题模型，标题请求不再等待对话请求。
 * - `off`：不发起任何模型标题请求，只保留本地确定性回退标题。
 */
export type SessionTitleModelMode = 'inherit' | 'custom' | 'off'

/**
 * 设置分节 `session-title` 的取值：模式决定路由来源，`custom` 才读路由字段。
 */
export interface SessionTitleModelSettings {
  /** 标题模型模式。 */
  readonly mode: SessionTitleModelMode
  /** 自定义模式的提供方路由；其他模式下被忽略。 */
  readonly provider?: string
  /** 自定义模式的模型 id；其他模式下被忽略。 */
  readonly model?: string
}

/** 标题模型设置所在的用户设置命名空间。 */
export const SESSION_TITLE_MODEL_SETTINGS_NAMESPACE = settingsNamespace('session-title')

/** 标题模型设置的 schema：模式有默认值，路由字段可同时缺席。 */
export const SessionTitleModelSettingsSchema: z<SessionTitleModelSettings> = z.object({
  mode: z.union(['inherit', 'custom', 'off'] as const).default('inherit'),
  provider: z.string(),
  model: z.string(),
})

/**
 * 校验标题模型设置的跨字段约束：路由字段必须成对且非空，自定义模式必须带路由。
 * @param settings - 合并后的设置取值。
 * @throws {Error} 当路由不成对、为空或自定义模式缺少路由时。
 */
function validateTitleModelSettings(settings: SessionTitleModelSettings): void {
  const provider = settings.provider
  const model = settings.model
  if ((provider === undefined) !== (model === undefined)) {
    throw new Error('session-title: provider and model must be set together')
  }
  for (const [name, value] of [['provider', provider], ['model', model]] as const) {
    if (value !== undefined && (value.length === 0 || value.trim() !== value)) {
      throw new Error(`session-title: ${name} must be a non-empty identifier without surrounding spaces`)
    }
  }
  if (settings.mode === 'custom' && provider === undefined) {
    throw new Error('session-title: the custom title model requires provider and model')
  }
}

/** Required deployment policy for one model-backed title plugin. */
export interface SessionTitleLlmConfig {
  /** Target word count for non-CJK titles. */
  readonly targetWords: number
  /** Target character count for Chinese, Japanese, or Korean titles. */
  readonly targetCjkCharacters: number
  /** Maximum UTF-8 bytes in the final JSON-framed user prompt. */
  readonly maxInputBytes: number
  /** Auxiliary generation output-token cap. */
  readonly maxOutputTokens: number
  /** End-to-end auxiliary request deadline in milliseconds. */
  readonly timeoutMs: number
  /** Title model mode; absent means the deployment default derived from the route pair. */
  readonly mode?: SessionTitleModelMode
  /** Optional explicit provider route; must be paired with `model`. */
  readonly provider?: string
  /** Optional explicit model id; must be paired with `provider`. */
  readonly model?: string
}

/** Validated immutable model-provider policy. */
export interface ResolvedSessionTitleLlmConfig extends SessionTitleLlmConfig {}

/** Shared Loader field schemas with no library defaults. */
export const SessionTitleLlmConfigFields = {
  targetWords: z.number().step(1).min(1).required(),
  targetCjkCharacters: z.number().step(1).min(1).required(),
  maxInputBytes: z.number().step(1).min(1).required(),
  maxOutputTokens: z.number().step(1).min(1).required(),
  timeoutMs: z.number().step(1).min(1).max(MAX_TIMER_DELAY_MS).required(),
  mode: z.union(['inherit', 'custom', 'off'] as const),
  provider: z.string(),
  model: z.string(),
}

/** Shared Loader schema with no library defaults. */
export const SessionTitleLlmConfigSchema: z<SessionTitleLlmConfig> = z.object(SessionTitleLlmConfigFields)

/** Complete configuration key set for direct construction validation. */
const CONFIG_KEYS: ReadonlySet<string> = new Set([
  'targetWords',
  'targetCjkCharacters',
  'maxInputBytes',
  'maxOutputTokens',
  'timeoutMs',
  'mode',
  'provider',
  'model',
])

/** Validate one positive integer limit. */
function assertPositiveInteger(name: string, value: number): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`session-title-llm: ${name} must be a positive integer`)
  }
}

/**
 * Validate and detach required model-provider configuration.
 * @param config - untrusted plugin configuration.
 * @returns immutable policy with the optional route pair preserved.
 */
export function resolveSessionTitleLlmConfig(
  config: SessionTitleLlmConfig,
): ResolvedSessionTitleLlmConfig {
  const candidate: unknown = config
  if (candidate === null || typeof candidate !== 'object') {
    throw new Error('session-title-llm: configuration is required')
  }
  const value = candidate as SessionTitleLlmConfig
  for (const key of Object.keys(value)) {
    if (!CONFIG_KEYS.has(key)) throw new Error(`session-title-llm: unknown config key "${key}"`)
  }
  assertPositiveInteger('targetWords', value.targetWords)
  assertPositiveInteger('targetCjkCharacters', value.targetCjkCharacters)
  assertPositiveInteger('maxInputBytes', value.maxInputBytes)
  assertPositiveInteger('maxOutputTokens', value.maxOutputTokens)
  assertPositiveInteger('timeoutMs', value.timeoutMs)
  if (value.timeoutMs > MAX_TIMER_DELAY_MS) {
    throw new Error(`session-title-llm: timeoutMs must not exceed ${MAX_TIMER_DELAY_MS}`)
  }
  // 组合层配置来自 Loader 之外的调用方，模式值按运行时事实校验。
  const mode: unknown = value.mode
  if (mode !== undefined && mode !== 'inherit' && mode !== 'custom' && mode !== 'off') {
    throw new Error('session-title-llm: mode must be "inherit", "custom", or "off"')
  }
  const hasProvider = value.provider !== undefined
  const hasModel = value.model !== undefined
  if (hasProvider !== hasModel) {
    throw new Error('session-title-llm: provider and model must be supplied together')
  }
  if (hasProvider
    && (typeof value.provider !== 'string' || value.provider.length === 0
      || typeof value.model !== 'string' || value.model.length === 0)) {
    throw new Error('session-title-llm: provider and model overrides must be non-empty strings')
  }
  if (value.mode === 'custom' && !hasProvider) {
    throw new Error('session-title-llm: the custom title model requires provider and model')
  }
  return deepFreeze({ ...value })
}

/**
 * 组合层给出的标题模型模式：显式模式优先，否则成对路由视为自定义模式，
 * 其余继承主模型。部署因此可以在 Loader 里钉住一个标题模型。
 * @param config - 已校验的组合层配置。
 * @returns 组合层标题模型模式。
 */
function compositionMode(config: ResolvedSessionTitleLlmConfig): SessionTitleModelMode {
  if (config.mode !== undefined) return config.mode
  return config.provider !== undefined ? 'custom' : 'inherit'
}

/** Select the provider-owned message subset from one fixed service revision. */
export type SessionTitleLlmMessageSelector = (
  messages: readonly SessionTitleUserMessage[],
) => readonly SessionTitleUserMessage[]

/**
 * Register one model-backed provider through the shared configuration and call policy.
 * @param ctx - context exposing the title and LLM services.
 * @param config - untrusted required deployment policy.
 * @param id - stable plugin id recorded with generated titles.
 * @param automatic - provider-owned automatic generation cadence.
 * @param selectMessages - exact source-message selection for one revision.
 */
export function registerSessionTitleLlmProvider(
  ctx: Context,
  config: SessionTitleLlmConfig,
  id: string,
  automatic: SessionTitleAutomaticMode,
  selectMessages: SessionTitleLlmMessageSelector,
): void {
  const resolved = resolveSessionTitleLlmConfig(config)
  const titleProvider = SessionTitleProviderId(id)
  // 组合层是用户设置分节的基底：部署可以钉住标题模型，用户设置再逐字段覆盖它。
  const base: SessionTitleModelSettings = {
    mode: compositionMode(resolved),
    ...resolved.provider === undefined ? {} : { provider: resolved.provider },
    ...resolved.model === undefined ? {} : { model: resolved.model },
  }
  let source: () => SessionTitleModelSettings = () => base
  ctx.sessionTitle.register({
    id: titleProvider,
    automatic,
    // 关闭模式下不安排任何模型标题请求；确定性回退标题不受影响。
    enabled: () => source().mode !== 'off',
    // 自定义模式自带路由，因此不必等会话记录主请求路由。
    ownRoute: () => {
      const { mode, provider, model } = source()
      if (mode !== 'custom') return undefined
      return provider === undefined || model === undefined ? undefined : { provider, model }
    },
    async generate(request) {
      return generateSessionTitleWithLlm(ctx, resolved, request, selectMessages(request.messages), titleProvider)
    },
  })
  installSettingsSection(ctx, SESSION_TITLE_MODEL_SETTINGS_NAMESPACE, SessionTitleModelSettingsSchema, base, {
    validate: validateTitleModelSettings,
    setSource: (current) => { source = current },
    // 每次排期与生成都读取当前设置，无需重建任何注册级事实。
    onChange: () => {},
  })
}

/** Stable language-aware system instruction shared by both provider plugins. */
function systemPrompt(config: ResolvedSessionTitleLlmConfig): string {
  return [
    'Create a concise title for an AI coding-assistant session from the supplied human messages.',
    'Return only the title on one line, **in plain text of natural language**, with no quotes, prefix, explanation, Markdown, XML, or terminal control codes. No code is allowed.',
    'Use the language of the messages.',
    `Aim for about ${config.targetWords} words in non-CJK languages or ${config.targetCjkCharacters} CJK characters.`,
  ].join('\n')
}

/** Frame exact messages as JSON so user text cannot break structural delimiters. */
function frameMessages(messages: readonly SessionTitleUserMessage[]): string {
  return `Generate the session title from this JSON array of human messages:\n${JSON.stringify(messages)}`
}

/** Translate terminal finish reasons into an auxiliary-call failure. */
function finishError(finish: FinishReason): Error | undefined {
  switch (finish.kind) {
    case 'stop':
      return undefined
    case 'error':
    case 'aborted': {
      const error = new Error(finish.failure.message) as Error & { code?: string }
      error.code = finish.failure.code
      return error
    }
    case 'max-tokens':
      return new Error('session-title-llm: title output reached maxOutputTokens')
    case 'tool-calls':
      return new Error('session-title-llm: title model unexpectedly requested a tool')
    default:
      return new Error(`session-title-llm: unsupported finish reason "${String((finish as { kind?: unknown }).kind)}"`)
  }
}

/**
 * Generate one title through the shared auxiliary LLM call.
 * @param ctx - context exposing the registered LLM service.
 * @param config - validated model-provider policy.
 * @param request - service-owned session, route, message snapshot, and cancellation.
 * @param selectedMessages - exact provider-selected subset to frame and attribute.
 * @param titleProvider - registered title-provider identity recorded with the request.
 * @returns normalized non-empty title, exact source seqs, and used model route.
 */
export async function generateSessionTitleWithLlm(
  ctx: Context,
  config: ResolvedSessionTitleLlmConfig,
  request: SessionTitleProviderRequest,
  selectedMessages: readonly SessionTitleUserMessage[],
  titleProvider: SessionTitleProviderId,
): Promise<SessionTitleProviderResult> {
  request.signal.throwIfAborted()
  if (selectedMessages.length === 0) {
    throw new Error('session-title-llm: at least one source message is required')
  }
  const framedInput = frameMessages(selectedMessages)
  const inputBytes = Buffer.byteLength(framedInput, 'utf8')
  if (inputBytes > config.maxInputBytes) {
    throw new Error(`session-title-llm: input is ${inputBytes} bytes, exceeding maxInputBytes ${config.maxInputBytes}`)
  }
  // 路由由服务解析后随请求给出：自定义标题模型，或会话已记录的主请求路由。
  const route = request.route
  if (route === undefined) {
    throw new Error('session-title-llm: no model route is available for this title revision')
  }
  const messages: Message[] = [createUserMessage({
    content: [{ type: 'text', text: framedInput }],
    source: { kind: 'plugin', plugin: 'dsh-session-title-llm' },
  })]
  const system = systemPrompt(config)
  using callDeadline = deadline(request.signal, config.timeoutMs, SESSION_TITLE_TIMEOUT_CODE)
  const options: GenerateOptions = deepFreeze({
    provider: route.provider,
    model: route.model,
    messages,
    system,
    maxTokens: config.maxOutputTokens,
    sessionId: request.session.id,
    purpose: 'session-title',
    signal: callDeadline.signal,
  })
  request.session.append('session/title-llm-request', {
    titleProvider,
    messageSeqs: selectedMessages.map(message => message.seq),
    route,
    system,
    messages,
    maxTokens: config.maxOutputTokens,
  })
  callDeadline.signal.throwIfAborted()
  const assembler = new BlockAssembler()
  for await (const chunk of ctx.llm.stream(options)) {
    callDeadline.signal.throwIfAborted()
    assembler.push(chunk)
  }
  callDeadline.signal.throwIfAborted()
  const terminalError = finishError(assembler.finish)
  if (terminalError !== undefined) throw terminalError
  const blocks = assembler.blocks()
  if (blocks.some(block => block.type === 'tool-call')) {
    throw new Error('session-title-llm: title output must contain text only')
  }
  const text = blocks
    .filter((block): block is Extract<(typeof blocks)[number], { type: 'text' }> => block.type === 'text')
    .map(block => block.text)
    .join(' ')
  const title = normalizeSessionTitle(text, Number.MAX_SAFE_INTEGER)
  if (title.length === 0) throw new Error('session-title-llm: title model produced no text')
  return {
    title,
    messageSeqs: selectedMessages.map(message => message.seq),
    model: route,
  }
}
