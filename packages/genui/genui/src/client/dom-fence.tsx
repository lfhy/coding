/**
 * DOM 围栏渲染通道：发现宿主 Markdown 代码表面，按源码语言接管 GenUI，
 * 并维护流式、定稿、诊断与卸载生命周期。
 *
 * 表面结构和 ChatSnapshot 源码恢复分别由 `dom-surface.ts` 与 `dom-source.ts`
 * 持有；本模块只保留渲染状态机和调度。流式阶段没有完整组件时挂载
 * `StreamingFence`，每次 raw 变化复用同一个 React 根；组件完整后立即换成真实
 * GenUI。定稿失败或渲染器卸载时始终恢复宿主原始代码块。
 */
import { type Key, type ReactNode } from 'react'
import type { Root } from 'react-dom/client'
import { mountDomRoot } from './dom-root.ts'
import type { Context } from '@deepseek-ai/cordis'
import type { SessionId } from 'coding-session/types'
import { GenuiActionContext, type GenuiActionHandler } from './action-context.ts'
import { withFileLinkContext, type FileLinkAvailability } from './file-link-context.tsx'
import { describeFenceFailure, FenceDiagnostic, renderResolvedFenceNode, type GenuiFenceContext } from './fence-render.tsx'
import { renderSvgFence } from './svg-fence.tsx'
import { StreamingFence } from './StreamingFence.tsx'
import { sourceLanguageOf, hostFenceIndexOf, chatSourceOf, createSourceLanguageResolver, sourceSessionOf, fenceIndexOf, anchorSeqOf } from './dom-source.ts'
import {
  CODE_CONTEXT,
  CONTAINER_CLASS,
  DIAGNOSTIC_CLASS,
  domLanguageLabelOf,
  findFenceCandidates,
  isGenericGenuiFence,
  isSettled,
  isTakeoverTagText,
  normalizeFenceLanguage,
  outermostSurfaceOf,
  PROCESSED,
  rawOf,
  rowOf,
  resetSurfaceDiagnostics,
  surfaceOf,
  surfaceRejection,
  SURFACE_EXCLUDES,
  tagTextBodyOf,
} from './dom-surface.ts'
import type { DomFenceLanguage } from './dom-surface.ts'

export { sourceLanguageOf, hostFenceIndexOf }

const SWEEP_MS = 1000
const SWEEP_BUDGET_MS = 8
const DIRTY_TARGET_LIMIT = 512
const ROTATION_ROWS = 24
const ROTATION_TICKS = 5
const NO_FILE_LINK_AVAILABILITY: FileLinkAvailability = {
  subscribe: () => () => {},
  getSnapshot: () => false,
}

interface Mount {
  root: Root
  container: HTMLElement
  block: HTMLElement
  lastRaw: string
  lastSettled: boolean
  language: 'dsh-ui' | 'svg'
}

interface DiagnosticMount {
  container: HTMLElement
  root: Root
  raw: string
}

export { setDomRootFactory } from './dom-root.ts'

/** 当前 DOM 语言与 ChatSnapshot 语言的统一读取。 */
function languageOf(
  block: Element,
  sourceLanguages: ReturnType<typeof createSourceLanguageResolver>,
): DomFenceLanguage | null | undefined {
  if (tagTextBodyOf(block) !== null) return 'dsh-ui'
  const domLanguage = normalizeFenceLanguage(domLanguageLabelOf(block))
  return domLanguage ?? normalizeFenceLanguage(sourceLanguages.get(block))
}

/**
 * 安装 DOM 通道。
 *
 * @param ctx - client context，读取当前会话与 assistant 源码
 * @param sendAction - 把围栏 action 投递到当前会话的回调
 * @param fileLinkAvailability - 宿主文件链接能力
 * @returns 卸载函数；卸载会断开观察器并恢复所有宿主代码块
 */
export function installDomFenceRenderer(
  ctx: Context,
  sendAction: (sessionId: SessionId, action: string, payload: Record<string, unknown>) => void,
  fileLinkAvailability: FileLinkAvailability = NO_FILE_LINK_AVAILABILITY,
): () => void {
  if (typeof document === 'undefined') return () => {}
  resetSurfaceDiagnostics()

  const mounts = new Map<HTMLElement, Mount>()
  const diagnostics = new Map<HTMLElement, DiagnosticMount>()
  const sourceLanguages = createSourceLanguageResolver(ctx)
  const dirtyTargets = new Map<Node, boolean>()
  const pendingCandidates = new Set<HTMLElement>()
  const queuedCandidates = new WeakSet<Element>()
  const awaitingSource = new Set<HTMLElement>()
  const deferredScans = new WeakSet<Node>()
  let disposed = false
  let rafId: number | null = null
  let rotationNext = 0
  let rotationTicks = 0
  let sourceChanged = false
  let activeChatSession: SessionId | undefined
  let unsubscribeChat: (() => void) | undefined
  let lastAvailableSessionId: SessionId | undefined

  const warned = new WeakSet<Element>()
  const warnOnce = (block: Element, message: string): void => {
    if (warned.has(block)) return
    warned.add(block)
    console.warn(`[genui] ${message}`)
  }

  const sessionIdOf = (): SessionId | undefined => {
    const source = sourceSessionOf(ctx)
    return source.available ? source.sessionId : undefined
  }

  /** 渲染树需要会话时，临时读取失败保留上一次身份，避免流式树重挂载。 */
  const sessionIdForRender = (preserve: boolean): SessionId | undefined => {
    const source = sourceSessionOf(ctx)
    if (!source.available) return preserve ? lastAvailableSessionId : undefined
    lastAvailableSessionId = source.sessionId
    return source.sessionId
  }

  const wrapFenceNode = (node: ReactNode, context: GenuiFenceContext, handler: GenuiActionHandler, streaming: boolean): ReactNode => (
    withFileLinkContext(
      ctx,
      fileLinkAvailability,
      context.sessionId,
      streaming,
      <GenuiActionContext.Provider value={handler}>{node}</GenuiActionContext.Provider>,
    )
  )

  /** 同一 assistant 行内维持稳定的 DOM source identity；streaming 也参与序号。 */
  const contextOf = (row: Element, block: Element, settled: boolean, preserveSession = false): { key: Key; context: GenuiFenceContext } => {
    const index = fenceIndexOf(ctx, row, block, sourceLanguages.get)
    const anchorKey = row.getAttribute('data-chat-anchor-key') ?? 'unknown'
    const key = `dom:${anchorKey}:${index}` as Key
    const sessionId = sessionIdForRender(preserveSession)
    const context: GenuiFenceContext = {
      ...(sessionId === undefined ? {} : { sessionId }),
      ...(settled ? { source: { id: key as string, order: [anchorSeqOf(row), 0, index] as const } } : {}),
    }
    return { key, context }
  }

  const clearDiagnostic = (block: HTMLElement): void => {
    const diagnostic = diagnostics.get(block)
    if (diagnostic === undefined) return
    diagnostics.delete(block)
    try { diagnostic.root.unmount() } catch { /* 宿主已移除子树时只需清理容器。 */ }
    diagnostic.container.remove()
  }

  const renderDiagnostic = (block: HTMLElement, raw: string): void => {
    if (describeFenceFailure(raw, { settled: true }) === null) {
      clearDiagnostic(block)
      return
    }
    const existing = diagnostics.get(block)
    if (existing !== undefined) {
      if (existing.container.parentElement !== block.parentElement
          || existing.container.nextElementSibling !== block) {
        block.before(existing.container)
      }
      if (existing.raw === raw) return
      clearDiagnostic(block)
    }
    const container = document.createElement('div')
    container.className = DIAGNOSTIC_CLASS
    block.before(container)
    try {
      const root = mountDomRoot(container, (root) => { root.render(<FenceDiagnostic raw={raw} settled />) })
      diagnostics.set(block, { container, root, raw })
    } catch (error) {
      container.remove()
      warnOnce(block, `无法挂载围栏诊断：${error instanceof Error ? error.message : String(error)}`)
    }
  }

  const unmountBlock = (block: HTMLElement): void => {
    const mount = mounts.get(block)
    if (mount === undefined) return
    mounts.delete(block)
    try { mount.root.unmount() } catch { /* 恢复宿主代码块优先于旧 React root 的清理。 */ }
    mount.container.remove()
    block.style.display = ''
    block.removeAttribute(PROCESSED)
    clearDiagnostic(block)
  }

  const sendActionForBlock = (block: Element, action: string, payload: Record<string, unknown>): void => {
    const sessionId = sessionIdOf()
    if (sessionId === undefined) {
      warnOnce(block, `无法解析当前会话，动作“${action}”未发送`)
      return
    }
    sendAction(sessionId, action, payload)
  }

  /** 读取块当前语言与状态；dom 明确语言优先于源码。 */
  const stateOf = (block: HTMLElement): { language: DomFenceLanguage | null | undefined; raw: string; settled: boolean } => ({
    language: languageOf(block, sourceLanguages),
    raw: rawOf(block),
    settled: isSettled(block),
  })

  /** 创建一个已解析的 React payload；流式不完整正文使用 StreamingFence。 */
  const payloadOf = (block: HTMLElement, row: Element, raw: string, settled: boolean, language: 'dsh-ui' | 'svg', preserveSession = false): {
    node: ReactNode | null
    context: GenuiFenceContext
    key: Key
  } => {
    const identity = contextOf(row, block, settled, preserveSession)
    const node = language === 'svg'
      ? renderSvgFence(raw, identity.key)
      : renderResolvedFenceNode(raw, identity.key, identity.context)
    if (node !== null || settled || language !== 'dsh-ui') return { node, ...identity }
    return { node: <StreamingFence />, ...identity }
  }

  const renderBlock = (block: HTMLElement): void => {
    if (block.hasAttribute(PROCESSED)) return
    const state = stateOf(block)
    const language = state.language
    const generic = language === undefined && state.settled && isGenericGenuiFence(block, state.raw)
    if (language !== 'dsh-ui' && language !== 'svg' && !generic) return
    if (!state.settled && language !== 'dsh-ui' && !generic) return
    if (state.raw.trim() === '') return
    const accepted: 'dsh-ui' | 'svg' = language === 'svg' ? 'svg' : 'dsh-ui'
    const row = rowOf(block)
    const rendered = payloadOf(block, row, state.raw, state.settled, accepted)
    if (rendered.node === null) {
      if (state.settled) {
        renderDiagnostic(block, state.raw)
        warnOnce(block, '定稿 GenUI 围栏无法解析，保留原始代码块')
      }
      return
    }
    clearDiagnostic(block)
    const container = document.createElement('div')
    container.className = CONTAINER_CLASS
    block.after(container)
    try {
      const handler: GenuiActionHandler = (action, payload) => { sendActionForBlock(block, action, payload) }
      const root = mountDomRoot(container, (root) => {
        root.render(wrapFenceNode(rendered.node, rendered.context, handler, !state.settled))
      })
      block.style.display = 'none'
      block.setAttribute(PROCESSED, '')
      mounts.set(block, {
        root,
        container,
        block,
        lastRaw: state.raw,
        lastSettled: state.settled,
        language: accepted,
      })
    } catch (error) {
      container.remove()
      warnOnce(block, `无法挂载 GenUI 围栏：${error instanceof Error ? error.message : String(error)}`)
    }
  }

  const enqueueCandidate = (candidate: Element | null | undefined): void => {
    if (candidate === null || candidate === undefined || candidate.hasAttribute(PROCESSED) || queuedCandidates.has(candidate)) return
    queuedCandidates.add(candidate)
    pendingCandidates.add(candidate as HTMLElement)
  }

  /** 只把变更节点附近的表面加入队列；大范围子树由预算调度。 */
  const discoverMutation = (target: Node, structural: boolean, deadline: number): void => {
    const element = target instanceof Element ? target : target.parentElement
    if (element === null || element.closest(SURFACE_EXCLUDES) !== null) return
    if (element.tagName === 'SPAN' && isTakeoverTagText(element)) enqueueCandidate(element)
    const context = element.closest(CODE_CONTEXT)
    if (context !== null) {
      const surface = outermostSurfaceOf(context)
      if (surface !== null && surfaceRejection(surface) === null) enqueueCandidate(surface)
      const pre = element.closest<HTMLElement>('pre')
      if (pre !== null) {
        const labeled = surfaceOf(pre)
        if (labeled !== null && surfaceRejection(labeled) === null) enqueueCandidate(labeled)
      }
    }
    if (!structural) return
    if (performance.now() >= deadline) {
      deferredScans.add(target)
      dirtyTargets.set(target, structural)
      return
    }
    const candidates = findFenceCandidates(element, { includeScope: true })
    for (let i = candidates.length - 1; i >= 0; i -= 1) enqueueCandidate(candidates[i])
  }

  const markDirty = (node: Node, structural: boolean): void => {
    if (disposed) return
    const element = node instanceof Element ? node : node.parentElement
    if (element === null || element.closest(`.${CONTAINER_CLASS}, .${DIAGNOSTIC_CLASS}`) !== null) return
    const previous = dirtyTargets.get(node)
    if (previous === undefined) {
      if (dirtyTargets.size < DIRTY_TARGET_LIMIT) dirtyTargets.set(node, structural)
    } else if (structural && !previous) dirtyTargets.set(node, true)
  }

  const noteSourceDecision = (block: HTMLElement): void => {
    if (block.hasAttribute(PROCESSED) || tagTextBodyOf(block) !== null) {
      awaitingSource.delete(block)
      return
    }
    const domLanguage = normalizeFenceLanguage(domLanguageLabelOf(block))
    const sourceLanguage = domLanguage === null ? sourceLanguages.get(block) : undefined
    if (domLanguage !== null || sourceLanguage !== undefined) {
      awaitingSource.delete(block)
      return
    }
    if (awaitingSource.size < DIRTY_TARGET_LIMIT) awaitingSource.add(block)
  }

  const requeueAwaitingSource = (): void => {
    for (const block of Array.from(awaitingSource)) {
      awaitingSource.delete(block)
      if (block.isConnected && !block.hasAttribute(PROCESSED)) enqueueCandidate(block)
    }
  }

  const resolveDirtyTargets = (deadline: number): void => {
    for (const [target, structural] of dirtyTargets) {
      if (performance.now() >= deadline) return
      dirtyTargets.delete(target)
      if (!target.isConnected) continue
      const force = deferredScans.delete(target)
      discoverMutation(target, structural, force ? Number.POSITIVE_INFINITY : deadline)
    }
  }

  const drainCandidates = (deadline: number): void => {
    for (const block of pendingCandidates) {
      if (performance.now() >= deadline) return
      pendingCandidates.delete(block)
      queuedCandidates.delete(block)
      if (!block.isConnected) continue
      const eligible = tagTextBodyOf(block) !== null ? isTakeoverTagText(block) : surfaceRejection(block) === null
      if (!eligible) {
        awaitingSource.delete(block)
        continue
      }
      renderBlock(block)
      noteSourceDecision(block)
    }
  }

  const keepDraining = (): void => {
    if (pendingCandidates.size > 0 || dirtyTargets.size > 0) schedule()
  }

  const syncChatSubscription = (sessionId: SessionId | undefined): void => {
    if (sessionId !== activeChatSession) {
      unsubscribeChat?.()
      unsubscribeChat = undefined
      activeChatSession = sessionId
    }
    if (sessionId !== undefined && unsubscribeChat === undefined) {
      unsubscribeChat = chatSourceOf(ctx, sessionId)?.subscribe(() => {
        sourceChanged = true
        schedule()
      })
    }
  }

  /** 仅修复宿主移走挂载容器；React 内容刷新在 sweep 中进行。 */
  const repairSurgery = (): void => {
    for (const [block, diagnostic] of Array.from(diagnostics)) {
      if (!block.isConnected) {
        clearDiagnostic(block)
      } else if (diagnostic.container.parentElement !== block.parentElement || diagnostic.container.nextElementSibling !== block) {
        block.before(diagnostic.container)
      }
    }
    for (const mount of Array.from(mounts.values())) {
      if (!mount.block.isConnected) {
        unmountBlock(mount.block)
        continue
      }
      if (mount.container.parentElement !== mount.block.parentElement || mount.container.previousElementSibling !== mount.block) {
        mount.block.after(mount.container)
      }
      if (!mount.container.isConnected) {
        unmountBlock(mount.block)
        continue
      }
      if (mount.block.style.display !== 'none') mount.block.style.display = 'none'
      if (!mount.block.hasAttribute(PROCESSED)) mount.block.setAttribute(PROCESSED, '')
    }
  }

  const refreshMount = (mount: Mount, state: ReturnType<typeof stateOf>, sourceUnavailable: boolean): void => {
    const block = mount.block
    if (mount.language === 'svg' && state.language !== 'svg') {
      unmountBlock(block)
      return
    }
    const validGenui = state.language === 'dsh-ui' || (state.language === undefined && state.settled && isGenericGenuiFence(block, state.raw))
    if (mount.language === 'dsh-ui' && !validGenui && !sourceUnavailable) {
      unmountBlock(block)
      return
    }
    const contentWiped = mount.container.childElementCount === 0
    if (mount.lastRaw === state.raw && mount.lastSettled === state.settled && !contentWiped) return
    const row = rowOf(block)
    const rendered = payloadOf(block, row, state.raw, state.settled, mount.language, true)
    if (rendered.node === null) {
      unmountBlock(block)
      if (state.settled) renderDiagnostic(block, state.raw)
      return
    }
    const handler: GenuiActionHandler = (action, payload) => { sendActionForBlock(block, action, payload) }
    try {
      if (contentWiped) {
        try { mount.root.unmount() } catch { /* 新 root 会接管已被宿主清空的容器。 */ }
        const fresh = document.createElement('div')
        fresh.className = CONTAINER_CLASS
        mount.container.remove()
        block.after(fresh)
        mount.container = fresh
        mount.root = mountDomRoot(fresh, (root) => {
          root.render(wrapFenceNode(rendered.node, rendered.context, handler, !state.settled))
        })
      } else {
        mount.root.render(wrapFenceNode(rendered.node, rendered.context, handler, !state.settled))
      }
      mount.lastRaw = state.raw
      mount.lastSettled = state.settled
    } catch (error) {
      unmountBlock(block)
      warnOnce(block, `无法刷新 GenUI 围栏：${error instanceof Error ? error.message : String(error)}`)
    }
  }

  const rotationSweep = (deadline: number): void => {
    const rows = document.querySelectorAll<HTMLElement>('[data-chat-flow-key], [data-chat-flow-kind]')
    if (rows.length === 0) return
    let visited = 0
    const count = Math.min(ROTATION_ROWS, rows.length)
    for (let i = 0; i < count; i += 1) {
      if (performance.now() >= deadline) break
      const row = rows[rows.length - 1 - ((rotationNext + i) % rows.length)]
      if (row !== undefined) for (const candidate of findFenceCandidates(row)) enqueueCandidate(candidate)
      visited = i + 1
    }
    rotationNext = (rotationNext + visited) % rows.length
  }

  const sweep = (): void => {
    if (disposed) return
    sourceLanguages.beginSweep()
    const sourceSession = sourceSessionOf(ctx)
    const sessionId = sourceSession.available ? sourceSession.sessionId : undefined
    syncChatSubscription(sessionId)
    for (const [block, mount] of Array.from(mounts)) {
      if (!block.isConnected) {
        unmountBlock(block)
        continue
      }
      const state = stateOf(block)
      const sourceUnavailable = state.language === undefined && (!sourceSession.available || sourceLanguages.isSessionUnavailable())
      refreshMount(mount, state, sourceUnavailable)
    }
    repairSurgery()
    for (const [block, diagnostic] of Array.from(diagnostics)) {
      if (!block.isConnected || block.hasAttribute(PROCESSED)) {
        clearDiagnostic(block)
      } else if (diagnostic.container.childElementCount === 0) {
        clearDiagnostic(block)
        renderDiagnostic(block, diagnostic.raw)
      }
    }
    if (sourceChanged) {
      sourceChanged = false
      requeueAwaitingSource()
    }
    const deadline = performance.now() + SWEEP_BUDGET_MS
    resolveDirtyTargets(deadline)
    drainCandidates(deadline)
    keepDraining()
  }

  function schedule(): void {
    if (disposed || rafId !== null) return
    rafId = window.requestAnimationFrame(() => {
      rafId = null
      sweep()
    })
  }

  const unsubscribeSessions = typeof ctx.sessions.list.subscribe === 'function' ? ctx.sessions.list.subscribe(schedule) : undefined
  const observer = new MutationObserver((records) => {
    // 宿主清空扩展根时先原位放回原 DOM，React fiber 与输入状态均不失效。
    for (const record of [...records].reverse()) {
      if (record.removedNodes.length === 0 || record.target.childNodes.length > 0) continue
      const mount = [...mounts.values()].find(item => item.container === record.target)
      if (mount !== undefined) {
        if (mount.block.isConnected) mount.container.append(...record.removedNodes)
        continue
      }
      const diagnostic = [...diagnostics.values()].find(item => item.container === record.target)
      diagnostic?.container.append(...record.removedNodes)
    }
    for (const record of records) {
      if (record.type === 'characterData') markDirty(record.target, false)
      else if (record.type === 'childList') for (const node of record.addedNodes) markDirty(node, true)
      else markDirty(record.target, true)
    }
    repairSurgery()
    schedule()
  })
  observer.observe(document.body, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['data-streaming'],
    characterData: true,
  })

  const interval = window.setInterval(() => {
    sweep()
    rotationTicks += 1
    if (rotationTicks % ROTATION_TICKS === 0) rotationSweep(performance.now() + SWEEP_BUDGET_MS)
    keepDraining()
  }, SWEEP_MS)

  const initial = findFenceCandidates()
  for (let i = initial.length - 1; i >= 0; i -= 1) enqueueCandidate(initial[i])
  sweep()

  return () => {
    disposed = true
    observer.disconnect()
    unsubscribeSessions?.()
    unsubscribeChat?.()
    unsubscribeChat = undefined
    window.clearInterval(interval)
    if (rafId !== null) {
      window.cancelAnimationFrame(rafId)
      rafId = null
    }
    dirtyTargets.clear()
    pendingCandidates.clear()
    awaitingSource.clear()
    for (const block of Array.from(mounts.keys())) unmountBlock(block)
    for (const block of Array.from(diagnostics.keys())) clearDiagnostic(block)
  }
}
