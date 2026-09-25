/**
 * Electron 桌面入口：Go helper 独占受管 Host 和 Remote-SSH，主进程拥有
 * 窗口、托盘及逐调用授权的最小 preload IPC。
 * @module @deepseek-ai/dsh-desktop-electron/main
 */

import { mkdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { app, BrowserWindow, dialog } from 'electron'
import { prepareDevelopmentDirectories } from './directories.ts'
import { launchHelper, type HelperClient } from './helper-client.ts'
import { createNativeChrome, type NativeChrome } from './native-chrome.ts'
import { installRemoteIpc } from './remote-ipc.ts'
import { resolveRuntimeConfig, type RuntimeConfig } from './runtime-config.ts'
import { createHostWindow } from './window.ts'

const repositoryRoot = resolve(fileURLToPath(new URL('../../..', import.meta.url)))

let mainWindow: BrowserWindow | undefined
let nativeChrome: NativeChrome | undefined
let runtimeConfig: RuntimeConfig
let helper: HelperClient | undefined
let helperClosing: Promise<void> | undefined
let disposeRemoteIpc: (() => void) | undefined
let disposeActivation: (() => void) | undefined
let disposeHelperClosed: (() => void) | undefined
let launching: Promise<void> | undefined
let startupAbort: AbortController | undefined
let quitting = false
let quitCompleted = false

/** 结束当前 helper：先请求它关闭 SSH/bridge，再有界终止自己持有的进程。 */
async function stopHelper(): Promise<void> {
  const current = helper
  if (current === undefined) return
  helper = undefined
  disposeRemoteIpc?.()
  disposeRemoteIpc = undefined
  disposeActivation?.()
  disposeActivation = undefined
  disposeHelperClosed?.()
  disposeHelperClosed = undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      current.request('shutdown', {}),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => { reject(new Error('Helper shutdown timed out')) }, 10_000)
      }),
    ])
  } catch {
    // shutdown 未响应不证明远端操作已停；仍只终止本次启动的 helper。
  } finally {
    clearTimeout(timer)
    await current.close()
  }
}

function scheduleHelperStop(): void {
  if (helperClosing !== undefined) return
  helperClosing = stopHelper().catch(() => undefined).finally(() => { helperClosing = undefined })
}

/** 再次打开窗口时重新发现 Host；原 Host 可按自己的空闲策略独立退出。 */
function openWindow(): Promise<void> {
  if (mainWindow !== undefined && !mainWindow.isDestroyed()) {
    nativeChrome?.showWindow()
    return Promise.resolve()
  }
  if (launching !== undefined) return launching

  const controller = new AbortController()
  startupAbort = controller
  launching = (async () => {
    await helperClosing
    if (!app.isPackaged) {
      const home = runtimeConfig.home
      await prepareDevelopmentDirectories({
        hostHome: home,
        installedHome: resolve(homedir(), '.dsh'),
        legacyDevelopmentHome: resolve(homedir(), '.dsh-dev'),
        userData: runtimeConfig.userData,
        workspace: runtimeConfig.cwd,
      })
    }
    const next = await launchHelper({ ...runtimeConfig.helper, signal: controller.signal })
    if (quitting || controller.signal.aborted) {
      await next.close()
      return
    }
    helper = next
    const window = createHostWindow(next.origin, {
      devTools: !app.isPackaged && process.env.DSH_ELECTRON_DEVTOOLS === '1',
      iconPath: runtimeConfig.iconPath,
    })
    mainWindow = window
    disposeRemoteIpc = installRemoteIpc({ window, origin: next.origin, helper: next })
    nativeChrome = createNativeChrome({ window, origin: next.origin, iconPath: runtimeConfig.iconPath })
    disposeActivation = next.onActivate(() => { nativeChrome?.showWindow() })
    disposeHelperClosed = next.onClosed((reason) => {
      if (helper !== next || quitting || reason === 'closed') return
      helper = undefined
      disposeRemoteIpc?.()
      disposeRemoteIpc = undefined
      if (!window.isDestroyed()) {
        dialog.showErrorBox('Coding 原生服务已停止', '远程连接和本地 Host 已断开。请重新启动桌面端。')
        window.destroy()
      }
    })
    window.on('close', (event) => {
      if (process.platform !== 'darwin' || quitting) return
      event.preventDefault()
      nativeChrome?.closeWindow()
    })
    window.on('closed', () => {
      if (mainWindow !== window) return
      nativeChrome?.dispose()
      nativeChrome = undefined
      mainWindow = undefined
      if (!quitting) scheduleHelperStop()
    })
  })().finally(() => {
    if (startupAbort === controller) startupAbort = undefined
    launching = undefined
  })
  return launching
}

async function start(): Promise<void> {
  runtimeConfig = await resolveRuntimeConfig({
    packaged: app.isPackaged,
    userHome: homedir(),
    resourcesPath: process.resourcesPath,
    repoRoot: repositoryRoot,
    environment: process.env,
  })
  if (app.isPackaged) {
    await mkdir(runtimeConfig.userData, { recursive: true, mode: 0o700 })
  } else {
    await prepareDevelopmentDirectories({
      hostHome: runtimeConfig.home,
      installedHome: resolve(homedir(), '.dsh'),
      legacyDevelopmentHome: resolve(homedir(), '.dsh-dev'),
      userData: runtimeConfig.userData,
      workspace: runtimeConfig.cwd,
    })
  }
  app.setName(app.isPackaged ? 'Coding' : 'Coding Dev')
  app.setPath('userData', runtimeConfig.userData)
  if (!app.requestSingleInstanceLock()) {
    app.quit()
    return
  }
  app.on('second-instance', () => { void openWindow().catch(reportError) })
  app.on('before-quit', (event) => {
    if (quitCompleted) return
    event.preventDefault()
    quitting = true
    startupAbort?.abort()
    nativeChrome?.dispose()
    void (async () => {
      await launching?.catch(() => undefined)
      await helperClosing?.catch(() => undefined)
      await stopHelper()
      quitCompleted = true
      app.quit()
    })().catch(() => {
      quitCompleted = true
      app.quit()
    })
  })
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })
  app.on('activate', () => { void openWindow().catch(reportError) })
  await app.whenReady()
  await openWindow()
}

function reportError(error: unknown): void {
  dialog.showErrorBox('Coding 启动失败', error instanceof Error ? error.message : String(error))
  app.quit()
}

void start().catch(reportError)
