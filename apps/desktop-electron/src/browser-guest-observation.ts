/** 原生 guest 的隔离世界观测与截图；导航或会话失效后拒绝发布迟到结果。 */

import type { Debugger } from 'electron'
import type { BrowserCapture, BrowserObservation } from 'coding-browser'
import { fail, GuestError, invalidate, refreshSummary, MAX_URL_LENGTH, OVERLONG_URL, FRAME_LIMIT,
  type Owner, type Tab } from './browser-guest-state.ts'
import { snapshotScript, type Snapshot } from './browser-guest-snapshot.ts'
import { fitBrowserPng } from './browser-image.ts'

const SCREENSHOT_TIMEOUT_MS = 5_000

/**
 * 创建管理器私有的观测操作；调用方负责串行化同一会话，并在操作前准备原生视图承载。
 * 截图超时只销毁当前会话；URL、导航代次、标签归属或页面变化使旧结果失效。
 * @param options - 当前会话注册表、当前会话销毁操作及经所有权校验的状态发布回调。
 * @returns URL 检查、隔离世界求值、稳定性检查、页面观测及 DOM 修订刷新操作。
 */
export function createGuestObserver(options: {
  owners: Map<string, Owner>
  destroy: (sessionId: string) => void
  emit: (sessionId: string, owner: Owner, capture?: BrowserCapture) => void
}) {
  const { owners, destroy, emit } = options

  function usableUrl(sessionId: string, owner: Owner, tab: Tab): string {
    const url = tab.view.webContents.getURL() || 'about:blank'
    if (url.length <= MAX_URL_LENGTH) return url
    if (tab.summary.url !== OVERLONG_URL || tab.capture) {
      invalidate(owner, tab)
      refreshSummary(tab)
      emit(sessionId, owner)
    }
    fail('browser page URL exceeds 4096 characters', 'BROWSER_FAILED')
  }

  function staleObservation(sessionId: string, owner: Owner, tab: Tab): never {
    invalidate(owner, tab)
    refreshSummary(tab)
    emit(sessionId, owner)
    fail('browser document changed during observation', 'BROWSER_STALE_REF')
  }

  /** 取得（必要时创建）本标签页的隔离世界；页面导航后旧 id 由导航处理清空。 */
  async function isolatedWorld(tab: Tab): Promise<{ debuggerApi: Debugger; contextId: number }> {
    const debuggerApi = tab.view.webContents.debugger
    if (!debuggerApi.isAttached()) debuggerApi.attach('1.3')
    if (tab.worldContextId === undefined) {
      const frame = await debuggerApi.sendCommand('Page.getFrameTree') as { frameTree: { frame: { id: string } } }
      const world = await debuggerApi.sendCommand('Page.createIsolatedWorld', {
        frameId: frame.frameTree.frame.id, worldName: 'dsh-guest', grantUniveralAccess: false,
      }) as { executionContextId: number }
      tab.worldContextId = world.executionContextId
    }
    return { debuggerApi, contextId: tab.worldContextId }
  }

  async function evaluate<T>(tab: Tab, expression: string): Promise<T> {
    const { debuggerApi, contextId } = await isolatedWorld(tab)
    const result = await debuggerApi.sendCommand('Runtime.evaluate', {
      expression, contextId, returnByValue: true, awaitPromise: true,
    }) as { result?: { value?: T }; exceptionDetails?: unknown }
    if (result.exceptionDetails || result.result?.value === undefined) fail('browser document evaluation failed', 'BROWSER_FAILED')
    return result.result.value
  }

  /**
   * 把模型给出的引用解析成 CDP 可寻址的文件输入句柄，并复核它仍是本次观测的那个元素。
   * 引用失效、身份变化、被禁用或指向非文件输入都以过期引用拒绝，不退回任何其它元素。
   * @param tab 引用所属标签页。
   * @param ref 模型给出的不透明引用。
   * @returns 文件输入元素的 CDP 远端对象 id，供 `DOM.setFileInputFiles` 使用。
   */
  async function fileInputObjectId(tab: Tab, ref: string): Promise<string> {
    const { debuggerApi, contextId } = await isolatedWorld(tab)
    const expression = `(() => { const ref = globalThis.__dshGuestRefs?.get(${JSON.stringify(ref)}); const el = ref?.el;
      if (!el || !el.isConnected) return null;
      if (ref.form !== (el.form ?? null)) return null;
      const path = globalThis.__dshGuestPath(el);
      if (path.length !== ref.path.length || path.some((part, i) =>
        part.node !== ref.path[i].node || part.parent !== ref.path[i].parent ||
        JSON.stringify(part.attributes) !== JSON.stringify(ref.path[i].attributes))) return null;
      if (JSON.stringify(ref.identity) !== JSON.stringify(globalThis.__dshGuestIdentity(el))) return null;
      if (el.disabled || el.matches(':disabled') || el.closest('[inert], [aria-disabled="true"]')) return null;
      if (!(el instanceof HTMLInputElement) || el.type !== 'file') return null;
      return el; })()`
    const result = await debuggerApi.sendCommand('Runtime.evaluate', {
      expression, contextId, returnByValue: false,
    }) as { result?: { objectId?: string }; exceptionDetails?: unknown }
    if (result.exceptionDetails || result.result?.objectId === undefined) {
      fail(`browser element ${ref} is not a file input in the current observation; use a ref listed under File inputs`, 'BROWSER_STALE_REF')
    }
    return result.result.objectId
  }

  function assertStable(sessionId: string, owner: Owner, tab: Tab, navigation: number): void {
    if (owners.get(sessionId) !== owner ||
      owner.tabs.get(tab.id) !== tab || tab.navigation !== navigation || tab.view.webContents.isDestroyed()) {
      fail('browser document changed during observation', 'BROWSER_STALE_REF')
    }
  }

  async function observe(sessionId: string, owner: Owner, tab: Tab, cursor: BrowserObservation['cursor'],
    captureImage = false): Promise<BrowserCapture> {
    const navigation = tab.navigation
    usableUrl(sessionId, owner, tab)
    // 导航后的新 frame 也须恢复隐藏绘制；仅构造时关闭节流不能保证原生 surface 就绪。
    tab.view.webContents.setBackgroundThrottling(false)
    const page = await evaluate<Snapshot>(tab, snapshotScript)
    assertStable(sessionId, owner, tab, navigation)
    const wc = tab.view.webContents
    if (page.href === null || page.href !== usableUrl(sessionId, owner, tab)) staleObservation(sessionId, owner, tab)
    const sections = `Page text:\n${page.text}\nElements:\n${page.entries.join('\n')}`
    // 没有文件输入的页面保持原有快照形状，省略空段。
    const snapshot = (page.fileEntries.length === 0 ? sections :
      `${sections}\nFile inputs:\n${page.fileEntries.join('\n')}`).slice(0, 12_000)
      .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, ' ')
    let png: Uint8Array | null = null
    // 原生页面未呈现时仍可观测 DOM；显式截图在隐藏工作台中也必须尝试捕获新画面。
    if (tab.everPresented || captureImage) {
      let timer: ReturnType<typeof setTimeout> | undefined
      let image: { data: string }
      try {
        image = await Promise.race([
          wc.debugger.sendCommand('Page.captureScreenshot', {
            format: 'png', captureBeyondViewport: false, fromSurface: true,
          }) as Promise<{ data: string }>,
          new Promise<never>((_resolve, reject) => {
            timer = setTimeout(() => {
              destroy(sessionId)
              reject(new GuestError('browser screenshot timed out; browser session closed', 'BROWSER_FAILED'))
            }, SCREENSHOT_TIMEOUT_MS)
          }),
        ])
      } finally { if (timer) clearTimeout(timer) }
      try { png = await fitBrowserPng(image.data, FRAME_LIMIT) }
      catch (error) {
        assertStable(sessionId, owner, tab, navigation)
        invalidate(owner, tab)
        emit(sessionId, owner)
        fail(error instanceof Error ? `browser screenshot processing failed: ${error.message}` :
          'browser screenshot processing failed', 'BROWSER_FAILED')
      }
    }
    assertStable(sessionId, owner, tab, navigation)
    if (page.href !== usableUrl(sessionId, owner, tab)) staleObservation(sessionId, owner, tab)
    // 页面其他区域可以在截图期间更新；引用在输入时逐一复核节点身份和命中位置。
    // 人工坐标输入仍以观测开始时的修订版复核，截图期间的任何变更会在输入前拒绝。
    refreshSummary(tab, page.title.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, ' '))
    const observation: BrowserObservation = { tabId: tab.id, generation: tab.generation,
      revision: ++tab.revision, url: page.href, title: tab.summary.title, snapshot,
      viewport: { ...owner.viewport }, cursor }
    const capture: BrowserCapture = { observation, png: png === null ? null : new Uint8Array(png) }
    tab.capture = capture
    tab.domRevision = page.domRevision
    owner.revision++
    emit(sessionId, owner, capture.png === null ? undefined : capture)
    return capture
  }

  async function refreshMutation(sessionId: string, owner: Owner, tab: Tab): Promise<void> {
    if (tab.domRevision === undefined) return
    const navigation = tab.navigation
    const current = await evaluate<{ revision: number; incomplete: boolean }>(tab,
      '({ revision: globalThis.__dshGuestReadMutationRevision(), incomplete: !!globalThis.__dshGuestObserverIncomplete })')
    assertStable(sessionId, owner, tab, navigation)
    if (current.incomplete || current.revision !== tab.domRevision) {
      invalidate(owner, tab)
      emit(sessionId, owner)
    }
  }

  return { usableUrl, evaluate, fileInputObjectId, assertStable, observe, refreshMutation }
}
