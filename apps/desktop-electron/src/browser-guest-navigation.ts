/** 原生 guest 导航的提交与停载恢复；会话所有权由调用方的生命周期回调核验。 */

import { allowedUrl, fail, invalidate, refreshSummary, type Owner, type Tab } from './browser-guest-state.ts'

const NAVIGATION_TIMEOUT_MS = 10_000
const NAVIGATION_STOP_TIMEOUT_MS = 3_000

/**
 * 等待当前导航达到人工提交或模型 DOM 就绪条件；本次 loadURL 的即时拒绝优先于成功回执。
 * 超时后等待加载停止与 CDP 响应；无法证明停稳时销毁当前会话，不影响其他会话。
 * @param _sessionId - 所属会话标识；具体所有权与资源释放由 lifecycle 闭包持有。
 * @param owner - 当前会话状态，停载恢复时撤销旧观测与审批目标。
 * @param tab - 本次导航的原生标签页，不得在等待期间替换。
 * @param url - 待校验的 HTTP(S) 或本地绝对 file:/// 导航地址。
 * @param lifecycle - 核验会话及标签归属、销毁当前会话和发布状态的调用方回调。
 * @param human - 人工导航只等待主 frame 提交；模型导航等待 DOM 就绪。
 * @returns 导航已就绪，或模型目标提交后已安全停载；其余失败保留原始诊断或浏览器错误码。
 */
export async function navigateGuest(_sessionId: string, owner: Owner, tab: Tab, url: string,
  lifecycle: { isCurrent: () => boolean; destroy: () => void; emit: () => void }, human = false): Promise<void> {
  const wc = tab.view.webContents
  const destination = allowedUrl(url)
  let started = false
  let committedUrl: string | undefined
  let committedNavigation: number | undefined
  let commitTask: ReturnType<typeof setImmediate> | undefined
  const destinations = new Set([destination])
  let resolveCommit!: (value: { timedOut: false; error?: unknown }) => void
  const committed = new Promise<{ timedOut: false; error?: unknown }>((resolve) => { resolveCommit = resolve })
  const onStart = (details: { isMainFrame: boolean; url: string }): void => {
    if (details.isMainFrame && lifecycle.isCurrent()) {
      if (commitTask) clearImmediate(commitTask)
      commitTask = undefined
      committedUrl = undefined
      started = details.url === destination
    }
  }
  const onRedirect = (details: { isMainFrame: boolean; url: string }): void => {
    if (started && details.isMainFrame && lifecycle.isCurrent()) {
      destinations.add(details.url)
    }
  }
  const onCommit = (_event: unknown, url: string): void => {
    if (!started || !destinations.has(url) || url !== wc.getURL() || !lifecycle.isCurrent() || wc.isDestroyed()) return
    try { allowedUrl(url) }
    catch (error) { resolveCommit({ timedOut: false, error }); return }
    committedUrl = url
    committedNavigation = tab.navigation
    // 同一事件循环内本次 loadURL 的拒绝优先于提交回执；旧加载的异步拒绝不影响本次导航。
    if (human) commitTask ??= setImmediate(() => { resolveCommit({ timedOut: false }) })
  }
  const onDomReady = (): void => {
    if (human || committedUrl === undefined || wc.getURL() !== committedUrl ||
      !lifecycle.isCurrent() || wc.isDestroyed()) return
    // DOM 已就绪即可观测；让同一事件循环中的 loadURL 拒绝先于成功回执。
    commitTask ??= setImmediate(() => { resolveCommit({ timedOut: false }) })
  }
  wc.on('did-start-navigation', onStart)
  wc.on('did-redirect-navigation', onRedirect)
  wc.on('did-navigate', onCommit)
  if (!human) wc.on('dom-ready', onDomReady)
  const completed = Promise.resolve().then(() => wc.loadURL(destination))
    .then(() => ({ timedOut: false as const }), (error: unknown) => ({ timedOut: false as const, error }))
  const readiness = Promise.race([completed, committed])
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<{ timedOut: true }>((resolve) => {
    timer = setTimeout(() => { resolve({ timedOut: true }) }, NAVIGATION_TIMEOUT_MS)
  })
  const result = await Promise.race([readiness, deadline])
  if (timer) clearTimeout(timer)
  if (commitTask) clearImmediate(commitTask)
  wc.removeListener('did-start-navigation', onStart)
  wc.removeListener('did-redirect-navigation', onRedirect)
  wc.removeListener('did-navigate', onCommit)
  if (!human) wc.removeListener('dom-ready', onDomReady)
  if (!result.timedOut) {
    // 保留 loadURL 的原始失败诊断，不能把被拒绝的导航当作已完成页面。
    if ('error' in result) throw result.error
    if (!lifecycle.isCurrent() || wc.isDestroyed()) {
      fail('browser navigation target changed', 'BROWSER_STALE_REF')
    }
    if (!human && committedNavigation !== undefined && committedNavigation !== tab.navigation) {
      fail('browser document changed during navigation', 'BROWSER_STALE_REF')
    }
    refreshSummary(tab)
    return
  }

  // 停止之后仍须等待原 loadURL 收敛，并确认主 frame 与 CDP 均可响应。
  // 超时的旧调用不再有任何继续观察或写回状态的机会。
  let stopTimer: ReturnType<typeof setTimeout> | undefined
  let quiescent = false
  const recovery = { expired: false }
  const stillRecovering = (): boolean => !recovery.expired
  try {
    wc.stop()
    quiescent = await Promise.race([
      (async () => {
        await completed
        if (recovery.expired || wc.isDestroyed() || wc.isLoadingMainFrame()) return false
        const debuggerApi = wc.debugger
        if (!debuggerApi.isAttached()) debuggerApi.attach('1.3')
        await debuggerApi.sendCommand('Page.getFrameTree')
        return stillRecovering() && !wc.isDestroyed() && !wc.isLoadingMainFrame()
      })().catch(() => false),
      new Promise<false>((resolve) => {
        stopTimer = setTimeout(() => { recovery.expired = true; resolve(false) }, NAVIGATION_STOP_TIMEOUT_MS)
      }),
    ])
  } catch { /* 无法证明导航停稳时只销毁当前 Session。 */ }
  finally { if (stopTimer) clearTimeout(stopTimer) }
  if (!quiescent) {
    lifecycle.destroy()
    fail('browser navigation timed out and could not be stopped safely; browser session closed', 'BROWSER_FAILED')
  }
  invalidate(owner, tab)
  refreshSummary(tab)
  lifecycle.emit()
  // 主 frame 已提交且可观测时，模型导航仍可返回该页面；保留严格文档校验。
  if (!human && committedUrl !== undefined && wc.getURL() === committedUrl &&
    committedNavigation !== undefined && committedNavigation + 1 === tab.navigation) return
  fail('browser navigation timed out; loading stopped, take a new snapshot of the current page', 'BROWSER_FAILED')
}
