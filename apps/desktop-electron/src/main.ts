/**
 * 与 Wails 并存的 Electron 开发入口。Host 和用户数据各自使用隔离目录，
 * 窗口只加载经受管 Host 协议验证的回环地址。
 * @module @deepseek-ai/dsh-desktop-electron/main
 */

import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { app, BrowserWindow, dialog } from 'electron'
import { prepareDevelopmentDirectories } from './directories.ts'
import { ensureManagedHost } from './managed-host.ts'
import { createHostWindow } from './window.ts'

const repositoryRoot = resolve(fileURLToPath(new URL('../../..', import.meta.url)))
const userHome = homedir()
const hostHome = join(userHome, '.dsh-electron-dev')
const installedHome = join(userHome, '.dsh')
const wailsDevelopmentHome = join(userHome, '.dsh-dev')
const userData = join(hostHome, 'electron-user-data')
const workspace = join(hostHome, 'workspace')
const developmentDirectories = {
  hostHome, installedHome, wailsDevelopmentHome, userData, workspace,
}

let mainWindow: BrowserWindow | undefined
let launching: Promise<void> | undefined
let startupAbort: AbortController | undefined
let quitting = false

/** 再次打开窗口时重新发现 Host；原 Host 可按自己的空闲策略独立退出。 */
function openWindow(): Promise<void> {
  if (mainWindow !== undefined && !mainWindow.isDestroyed()) {
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.show()
    mainWindow.focus()
    return Promise.resolve()
  }
  if (launching !== undefined) return launching

  const controller = new AbortController()
  startupAbort = controller
  launching = (async () => {
    // macOS 关窗后进程仍存活；复开前也要拒绝被换成安装版的目录链接。
    await prepareDevelopmentDirectories(developmentDirectories)
    const { origin } = await ensureManagedHost({
      home: hostHome,
      cwd: workspace,
      repoRoot: repositoryRoot,
      signal: controller.signal,
    })
    if (quitting || controller.signal.aborted) return
    const window = createHostWindow(origin, { devTools: process.env.DSH_ELECTRON_DEVTOOLS === '1' })
    mainWindow = window
    window.on('closed', () => {
      if (mainWindow === window) mainWindow = undefined
    })
  })().finally(() => {
    if (startupAbort === controller) startupAbort = undefined
    launching = undefined
  })
  return launching
}

async function start(): Promise<void> {
  await prepareDevelopmentDirectories(developmentDirectories)
  app.setName('Coding Electron Dev')
  app.setPath('userData', userData)
  if (!app.requestSingleInstanceLock()) {
    app.quit()
    return
  }
  app.on('second-instance', () => { void openWindow().catch(reportError) })
  app.on('before-quit', () => {
    quitting = true
    startupAbort?.abort()
  })
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })
  app.on('activate', () => { void openWindow().catch(reportError) })
  await app.whenReady()
  await openWindow()
}

function reportError(error: unknown): void {
  dialog.showErrorBox('Coding Electron Dev 启动失败', error instanceof Error ? error.message : String(error))
  app.quit()
}

void start().catch(reportError)
