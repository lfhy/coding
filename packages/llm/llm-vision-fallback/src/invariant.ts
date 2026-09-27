/** 视觉描述日志事实与其原始图片节点的关系校验。 */

import { isDeepStrictEqual } from 'node:util'
import type { Context } from '@deepseek-ai/cordis'
import { contentHasImage } from '@deepseek-ai/dsh-llm'
import { isReplacementSurfaceEvent } from '@deepseek-ai/dsh-session'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type { InvariantFailure, InvariantInstaller } from '@deepseek-ai/dsh-invariants'
import { collectImages, substituteImages } from './content.ts'
import type {} from './index.ts'

const PACKAGE_NAME = '@deepseek-ai/dsh-llm-vision-fallback'

/** Cordis 不变量伴生插件名称。 */
export const name = 'llm-vision-fallback-invariant'
/** 注册前要求不变量服务。 */
export const inject = ['invariants']

/** 请求可能失败，因此只约束输入事实，不要求其后存在结果。 */
function validateRequest(history: readonly SessionEvent[], event: SessionEvent<'vision/request'>, fail: InvariantFailure): void {
  const data = event.data
  const source = history[data.sourceSeq]
  if (source?.type !== 'user/message' && source?.type !== 'tool/result') {
    fail('vision/request sourceSeq must cite an earlier user/message or tool/result')
  }
  const original = source.type === 'user/message' ? source.data.content : source.data.message.content
  const refs: typeof data.attachment[] = []
  collectImages(original, refs)
  if (!refs.some(ref => isDeepStrictEqual(ref, data.attachment))) {
    fail('vision/request attachment must belong to its source image node')
  }
  if (!data.provider || !data.model || !Number.isSafeInteger(data.maxTokens) || data.maxTokens < 1
    || (data.reasoningEffort !== undefined && !data.reasoningEffort)
    || !data.system || !Number.isSafeInteger(data.promptVersion) || data.promptVersion < 1) {
    fail('vision/request requires exact route, positive maxTokens, system prompt and version')
  }
}

/** 校验可重新加载的来源记录，不要求替换已经提交（中途故障可留下未引用事实）。 */
function validateFact(history: readonly SessionEvent[], event: SessionEvent<'vision/description'>, fail: InvariantFailure): void {
  const data = event.data
  const source = history[data.sourceSeq]
  if (source?.type !== 'user/message' && source?.type !== 'tool/result') {
    fail('vision/description sourceSeq must cite an earlier user/message or tool/result')
  }
  const original = source.type === 'user/message' ? source.data.content : source.data.message.content
  if (!contentHasImage(original)) fail('vision/description source must contain an image')
  const refs: typeof data.attachments = []
  collectImages(original, refs)
  if (!Array.isArray(data.attachments) || !Array.isArray(data.descriptions) || !Array.isArray(data.requestSeqs)
    || data.attachments.length === 0 || data.attachments.length !== data.descriptions.length
    || data.attachments.length !== data.requestSeqs.length
    || !isDeepStrictEqual(data.attachments, refs)
    || data.descriptions.some(text => typeof text !== 'string' || text.trim().length === 0)) {
    fail('vision/description must pair each source attachment with a non-empty description')
  }
  if (!Number.isSafeInteger(data.promptVersion) || data.promptVersion < 1
    || typeof data.prompt !== 'string' || data.prompt.length === 0) {
    fail('vision/description must retain its exact non-empty prompt and positive version')
  }
  if (!data.provider || !data.model) fail('vision/description requires a provider and model')
  for (const [index, seq] of data.requestSeqs.entries()) {
    if (!Number.isSafeInteger(seq) || seq < 0 || (index > 0 && seq <= (data.requestSeqs[index - 1] ?? -1))) {
      fail('vision/description requestSeqs must be ordered unique earlier event sequences')
    }
    const request = history[seq]
    if (request?.type !== 'vision/request'
      || request.data.sourceSeq !== data.sourceSeq
      || !isDeepStrictEqual(request.data.attachment, data.attachments[index])
      || request.data.provider !== data.provider || request.data.model !== data.model
      || request.data.system !== data.prompt || request.data.promptVersion !== data.promptVersion) {
      fail('vision/description must cite matching exact vision/request facts')
    }
  }
}

/** 已落地替换必须引用一项描述事实，并且不再把图片送入模型 surface。 */
function validateReplacement(history: readonly SessionEvent[], event: SessionEvent, fail: InvariantFailure): void {
  if (!isReplacementSurfaceEvent(event)) return
  if (event.type !== 'user/message' && event.type !== 'tool/result') return
  const facts = event.sourceEventSeqs?.filter(seq => history[seq]?.type === 'vision/description') ?? []
  if (facts.length === 0) return
  if (facts.length !== 1) fail('vision replacement must cite exactly one description fact')
  const fact = history[facts[0] ?? -1]
  if (fact?.type !== 'vision/description'
    || fact.data.sourceSeq !== event.surfaceOp.start
    || event.surfaceOp.start !== event.surfaceOp.end) {
    fail('vision replacement must rewrite exactly the fact source node')
  }
  const source = history[fact.data.sourceSeq]
  if (source?.type !== event.type) fail('vision replacement must preserve its source event type')
  const content = event.type === 'user/message' ? event.data.content : event.data.message.content
  if (contentHasImage(content)) fail('vision replacement cannot retain image blocks')
  const original = source.type === 'user/message' ? source.data.content : source.data.message.content
  const position = { index: 0 }
  const expected = substituteImages(original, fact.data.descriptions, position)
  if (position.index !== fact.data.descriptions.length || !isDeepStrictEqual(content, expected)) {
    fail('vision replacement content must exactly substitute recorded descriptions in image order')
  }
  const expectedData: unknown = source.type === 'user/message'
    ? { ...source.data, content: expected }
    : { ...source.data, message: { ...source.data.message, content: expected } }
  if (!isDeepStrictEqual(event.data, expectedData)) {
    fail('vision replacement must preserve all source event fields except image content')
  }
}

/** 重放旧日志和观察新追加记录使用相同约束。 */
function validateSession(session: Session, fail: InvariantFailure): void {
  for (const [index, event] of session.events.entries()) {
    const history = session.events.slice(0, index)
    if (event.type === 'vision/request') validateRequest(history, event, fail)
    else if (event.type === 'vision/description') validateFact(history, event, fail)
    else validateReplacement(history, event, fail)
  }
}

const install: InvariantInstaller = Object.assign((ctx: Context, fail: InvariantFailure) => {
  for (const session of ctx.sessions.list()) validateSession(session, fail)
  ctx.on('session/created', (session) => { validateSession(session, fail) }, { global: true })
  ctx.on('internal/dispatch', (_mode, eventName, args) => {
    if (eventName !== 'session/event') return
    const [session, event] = args as [Session, SessionEvent]
    const history = session.events
    if (event.type === 'vision/request') validateRequest(history, event, fail)
    else if (event.type === 'vision/description') validateFact(history, event, fail)
    else validateReplacement(history, event, fail)
  }, { global: true })
}, { inject: ['sessions'] })

/**
 * 注册视觉描述来源和替换关系的不变量。
 * @param ctx - 持有不变量服务的插件上下文。
 * @returns 注册释放函数。
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
