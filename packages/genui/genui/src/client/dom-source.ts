/**
 * GenUI DOM 围栏的源码身份与会话恢复。
 *
 * DOM 只能可靠读取宿主代码表面和 assistant 行的 `data-chat-node-key`；原始
 * Markdown 语言仍以 ChatSnapshot 为准。这里把两者的序号、会话绑定和缓存
 * 收拢起来，避免渲染生命周期模块重新实现源码查找。
 */
import type { Context } from '@deepseek-ai/cordis'
import type { ChatNode } from 'coding-client-ui-conversation/client'
import type { ChatSnapshot } from 'coding-client-runtime/client'
import type { SessionId } from 'coding-session/types'
import { sourceFencesOfAssistant, sourceLanguageAt } from './source-fence.ts'
import {
  ASSISTANT_FLOW_ROW,
  closestCodeBlockSurface,
  codeBlockSurfaces,
  CONTAINER_CLASS,
  DIAGNOSTIC_CLASS,
  domLanguageLabelOf,
  findFenceCandidates,
  isGenericGenuiFence,
  isPlausibleFenceSurface,
  normalizeFenceLanguage,
  rawOf,
  TAG_TEXT_EXCLUDES,
  tagTextBodyOf,
} from './dom-surface.ts'

/** 读取当前查看的会话：列表快照里的 current 即主视图选择。 */
export function sourceSessionOf(ctx: Context): { available: true; sessionId: SessionId | undefined } | { available: false } {
  try {
    return {
      available: true,
      sessionId: ctx.sessions.list.getSnapshot().current,
    }
  } catch {
    return { available: false }
  }
}

/** 读取当前主视图会话，供源码围栏与动作路由共用。 */
export function sessionIdOfForSource(ctx: Context): SessionId | undefined {
  const sourceSession = sourceSessionOf(ctx)
  return sourceSession.available ? sourceSession.sessionId : undefined
}

/** 经 sessions.binding 取该会话的 SessionFace（本身是会话快照的 Observable）。 */
export interface ChatSourceHandle {
  getSnapshot: () => ChatSnapshot | undefined
  subscribe: (listener: () => void) => (() => void) | undefined
}

export function chatSourceOf(ctx: Context, sessionId: SessionId): ChatSourceHandle | undefined {
  try {
    const binding = ctx.sessions.binding(sessionId)
    if (binding === undefined) return undefined
    const session = binding.session
    return {
      getSnapshot: () => {
        try {
          return session.getSnapshot().chat
        } catch {
          return undefined
        }
      },
      subscribe: (listener) => {
        try {
          return session.subscribe(listener)
        } catch {
          return undefined
        }
      },
    }
  } catch {
    return undefined
  }
}

/** 返回一行中宿主 Markdown 代码表面的零基序号；普通 JSON 也占一个位置。 */
export function hostFenceIndexOf(row: Element, block: Element): number {
  const blocks = codeBlocksOf(row)
  return blocks.indexOf(block as HTMLElement)
}

/** 返回 assistant 行内所有宿主代码表面，顺序必须与 ChatSnapshot Markdown 围栏一致。 */
function codeBlocksOf(row: Element): HTMLElement[] {
  return codeBlockSurfaces(row).filter((candidate) => {
    if (closestCodeBlockSurface(candidate.parentElement) !== null) return false
    if (candidate.closest(`.${CONTAINER_CLASS}, .${DIAGNOSTIC_CLASS}, [data-genui], [data-genui-svg-fence]`) !== null) return false
    if (candidate.closest(TAG_TEXT_EXCLUDES) !== null) return false
    if (candidate.closest(ASSISTANT_FLOW_ROW) !== row) return false
    return candidate.querySelector('pre') !== null
      && isPlausibleFenceSurface(candidate)
  })
}

/**
 * 从当前 assistant 行对应的源码围栏读取语言。
 *
 * @param ctx - 当前客户端上下文
 * @param block - 宿主 Markdown 代码表面
 * @returns 原始 language；null 表示明确无语言，undefined 表示源码暂不可用
 */
export function sourceLanguageOf(ctx: Context, block: Element): string | null | undefined {
  const row = block.closest<HTMLElement>(`${ASSISTANT_FLOW_ROW}[data-chat-node-key]`)
  if (row === null || row.dataset.chatGroupPart === 'reasoning') return undefined
  const nodeKey = row.dataset.chatNodeKey
  const index = hostFenceIndexOf(row, block)
  const sessionId = sessionIdOfForSource(ctx)
  if (!nodeKey || index < 0 || sessionId === undefined) return undefined
  const chat = chatSourceOf(ctx, sessionId)?.getSnapshot()
  return sourceLanguageAt(chat, nodeKey, index)
}

/** 源码解析器对每次 sweep 的缓存接口。 */
export interface SourceLanguageResolver {
  beginSweep: () => void
  get: (block: Element) => string | null | undefined
  isSessionUnavailable: () => boolean
}

/**
 * 为一次 DOM sweep 创建源码语言解析器。
 *
 * 已确认 opening line 的语言会按 block、session 与 node key 稳定缓存；源码
 * 节点晚到时返回 undefined 并保留候选，ChatSnapshot 通知后重新排队，不会
 * 因一次空快照永久遗漏。
 */
export function createSourceLanguageResolver(ctx: Context): SourceLanguageResolver {
  const stableLanguages = new WeakMap<Element, { sessionId: SessionId; nodeKey: string; language: string | null }>()
  let sweepLanguages = new Map<Element, string | null | undefined>()
  let parsedNodes = new Map<string, ReturnType<typeof sourceFencesOfAssistant>>()
  let sessionId: SessionId | undefined
  let chat: ChatSnapshot | undefined
  let chatRead = false
  let sessionUnavailable = false

  return {
    beginSweep() {
      sweepLanguages = new Map()
      parsedNodes = new Map()
      sessionId = undefined
      chat = undefined
      chatRead = false
      sessionUnavailable = false
    },
    isSessionUnavailable() {
      return sessionUnavailable
    },
    get(block) {
      if (sweepLanguages.has(block)) return sweepLanguages.get(block)
      const row = block.closest<HTMLElement>(`${ASSISTANT_FLOW_ROW}[data-chat-node-key]`)
      if (row === null || row.dataset.chatGroupPart === 'reasoning') return undefined
      const nodeKey = row.dataset.chatNodeKey
      const sourceSession = sourceSessionOf(ctx)
      if (!sourceSession.available) {
        sessionUnavailable = true
        sweepLanguages.set(block, undefined)
        return undefined
      }
      const activeSessionId = sourceSession.sessionId
      if (!nodeKey || activeSessionId === undefined) return undefined

      const stable = stableLanguages.get(block)
      if (stable?.sessionId === activeSessionId && stable.nodeKey === nodeKey) {
        sweepLanguages.set(block, stable.language)
        return stable.language
      }
      if (!chatRead || sessionId !== activeSessionId) {
        sessionId = activeSessionId
        chat = chatSourceOf(ctx, activeSessionId)?.getSnapshot()
        chatRead = true
      }
      const node = chat?.nodes.get(nodeKey)
      if (node?.kind !== 'assistant-step') return undefined
      const assistantNode = node as ChatNode<'assistant-step'>
      let fences = parsedNodes.get(nodeKey)
      if (fences === undefined) {
        fences = sourceFencesOfAssistant(assistantNode.data.blocks)
        parsedNodes.set(nodeKey, fences)
      }
      const index = hostFenceIndexOf(row, block)
      if (index < 0) return undefined
      const fence = fences[index]
      const language = normalizeFenceLanguage(fence?.lang)
      if (fence !== undefined && fence.openingLineComplete) {
        stableLanguages.set(block, { sessionId: activeSessionId, nodeKey, language: fence.lang })
      }
      sweepLanguages.set(block, language)
      return language
    },
  }
}

/**
 * 返回稳定的一基序号，用于 settled GenUI 的 source identity。
 * streaming fence 也参与计数，保证同一行多个围栏在 streaming→settled 时不换 key。
 */
export function fenceIndexOf(
  ctx: Context,
  row: Element,
  block: Element,
  sourceLanguage: (block: Element) => string | null | undefined = candidate => sourceLanguageOf(ctx, candidate),
): number {
  const scope = row.getAttribute('data-chat-anchor-key') === null ? document : row
  let index = 0
  for (const candidate of findFenceCandidates(scope)) {
    if (candidate.closest(ASSISTANT_FLOW_ROW) !== row && scope === row) continue
    if (candidate.closest('[data-chat-group-part="reasoning"]') !== null) continue
    const rawLanguage = tagTextBodyOf(candidate) !== null ? 'dsh-ui' : domLanguageLabelOf(candidate) ?? sourceLanguage(candidate)
    const language = normalizeFenceLanguage(rawLanguage)
    if (language === 'dsh-ui' || (language === undefined && isGenericGenuiFence(candidate, rawOf(candidate)))) {
      index += 1
      if (candidate === block) return index
    }
  }
  return index + 1
}

/**
 * messageSeq 估计值：assistant row 的 anchor key 是 `<turn>:<step>`，是跨刷新
 * 仍单调增长的唯一消息序号。缺失 anchor 时退化为当前文档顺序。
 */
export function anchorSeqOf(row: Element): number {
  const key = row.getAttribute('data-chat-anchor-key') ?? ''
  const turnStep = /assistant-step(\d+):(\d+)$/.exec(key)
  if (turnStep !== null) {
    const turn = Number(turnStep[1])
    const step = Number(turnStep[2])
    if (Number.isFinite(turn) && Number.isFinite(step)) return turn * 1000 + step
  }
  const rows = document.querySelectorAll('[data-chat-anchor-key], [data-chat-flow-key], [data-chat-flow-kind]')
  for (let i = 0; i < rows.length; i += 1) {
    if (rows[i] === row) return i
  }
  return 0
}
