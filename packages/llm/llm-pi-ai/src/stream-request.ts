/**
 * pi-ai 协议的请求与响应转换；渠道拥有者在调用前确定模型、凭据和本次传输。
 * @module coding-llm-pi-ai/stream-request
 */

import type { Api, Model, ProviderStreams, SimpleStreamOptions } from '@earendil-works/pi-ai'
import type { AttachmentStore } from 'coding-attachment'
import { contentHasImage, LlmError } from 'coding-llm'
import type { GenerateOptions, StreamChunk } from 'coding-llm'
import { toPiContext } from './context.ts'
import { toStreamChunks } from './stream.ts'

/** 已解析的一次协议请求，不持有渠道注册状态。 */
export interface PiAiStreamRequest {
  model: Model<Api>
  stream: ProviderStreams['streamSimple']
  streamOptions: SimpleStreamOptions
  maxRequestImageBytes: number
  resolveAttachments?: () => AttachmentStore | undefined
  onReplayDegrade?: (reason: string) => void
}

function isResponsesModel(model: Model<Api>): model is Model<
  'openai-responses' | 'azure-openai-responses' | 'openai-codex-responses'
> {
  return model.api === 'openai-responses'
    || model.api === 'azure-openai-responses'
    || model.api === 'openai-codex-responses'
}

/** Responses 原生语法由协议与配置决定；不改写已注册的模型或在途请求。 */
function nativeGrammarModel(model: Model<Api>, options: GenerateOptions): Model<Api> {
  if (!isResponsesModel(model) || !options.tools?.some(tool => tool.inputFormat?.type === 'grammar')
    || model.compat?.supportsOpenAIGrammarTools !== undefined) return model
  return { ...model, compat: { ...model.compat, supportsOpenAIGrammarTools: true } }
}

/**
 * 将 Harness 历史交给选定的协议，并翻译响应事件和同协议回放状态。
 * @param options - 渠道已确认可接受的生成请求。
 * @param request - 模型、协议实现、请求级选项及附件解析。
 * @returns Harness 流；取消和空闲超时由调用方管理。
 */
export async function* streamPiAiRequest(options: GenerateOptions, request: PiAiStreamRequest): AsyncGenerator<StreamChunk> {
  const model = nativeGrammarModel(request.model, options)
  const nativeGrammarTools = isResponsesModel(model) && model.compat?.supportsOpenAIGrammarTools === true
  const containsImage = options.messages.some(message => contentHasImage(message.content))
  if (containsImage && !model.input.includes('image')) {
    throw new LlmError(`pi-ai model "${model.id}" does not support image input`, 'UNSUPPORTED_CONTENT')
  }
  const attachments = containsImage ? request.resolveAttachments?.() : undefined
  if (containsImage && attachments === undefined) {
    throw new LlmError('pi-ai image input requires the durable attachment service', 'UNSUPPORTED_CONTENT')
  }
  const context = attachments === undefined
    ? toPiContext(options, undefined, request.onReplayDegrade, undefined, nativeGrammarTools)
    : await toPiContext(options, attachments, request.onReplayDegrade, request.maxRequestImageBytes, nativeGrammarTools)
  const events = request.stream(model, context, {
    ...request.streamOptions,
    ...options.temperature === undefined ? {} : { temperature: options.temperature },
    ...options.maxTokens === undefined ? {} : { maxTokens: options.maxTokens },
    ...options.sessionId === undefined ? {} : { sessionId: String(options.sessionId) },
  })
  yield* toStreamChunks(events, model.contextWindow)
}
