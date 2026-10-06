/** 浏览器观测独立占用 workbench.browser；Host 页面不进入 Client DOM。 */

import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { ChatBrowserLinks } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-open-in-app/client'
import { BrowserMirrorController, desktopBrowserPresentation } from './controller.ts'
import { BrowserMirror, BrowserTabs, type BrowserMirrorInjected } from './BrowserMirror.tsx'
import { en, NS, zh, type BrowserMirrorKey } from './locales.ts'

type LinkClick = { interactionEpoch: number; selectedTabId?: string }
type LinkOpener = (url: string, isCurrent: () => boolean, shouldReveal: () => boolean,
  click: LinkClick) => Promise<void>
type LinkOwner = { open: LinkOpener; clickState: () => LinkClick }
type LinkJob = {
  url: string
  sequence: number
  click: LinkClick
  resolve: () => void
  reject: (error: unknown) => void
}
type LinkQueue = { owner: LinkOwner; jobs: LinkJob[]; running: boolean; cancelled: boolean; sequence: number }

// 每次点击均有独立任务；上限限制长时间 Host 无响应时的内存与待执行导航数量。
const MAX_QUEUED_LINKS = 32

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** 浏览器画面区的展示文案。 */
    'browser-mirror': BrowserMirrorKey
  }
}

/** 人工导航经同源连接服务发往 Host。 */
export const inject = ['slots', 'locale', 'connection']

/**
 * 注册每会话只读截图贡献；slot 消失时销毁会话控制器。
 * @param ctx - Client 插件上下文。
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-browser: dictionaries')
  const connection = ctx.get('connection') as ConnectionHandle
  const controllers = new Map<string, BrowserMirrorController>()
  const openers = new Map<string, LinkOwner>()
  const queues = new Map<string, LinkQueue>()
  const cancelQueue = (sessionId: string, queue: LinkQueue) => {
    queue.cancelled = true
    const waiting = queue.jobs.splice(queue.running ? 1 : 0)
    for (const job of waiting) job.reject(new Error('会话已切换，请在当前会话重试'))
    if (queues.get(sessionId) === queue) queues.delete(sessionId)
  }
  const registerLinkOpener = (sessionId: string, open: LinkOpener, clickState: () => LinkClick) => {
    const previous = queues.get(sessionId)
    if (previous !== undefined) cancelQueue(sessionId, previous)
    const owner = { open, clickState }
    openers.set(sessionId, owner)
    return () => {
      if (openers.get(sessionId) !== owner) return
      openers.delete(sessionId)
      const queue = queues.get(sessionId)
      if (queue !== undefined) cancelQueue(sessionId, queue)
    }
  }
  const drain = (sessionId: string, queue: LinkQueue): void => {
    if (queue.running) return
    queue.running = true
    void (async () => {
      while (!queue.cancelled && queue.jobs.length > 0) {
        const job = queue.jobs[0]
        if (job === undefined) break
        const current = () => !queue.cancelled && openers.get(sessionId) === queue.owner
        try {
          if (!current()) throw new Error('会话已切换，请在当前会话重试')
          await queue.owner.open(job.url, current,
            () => current() && queue.sequence === job.sequence, job.click)
          if (!current()) throw new Error('会话已切换，请在当前会话重试')
          job.resolve()
        } catch (error) { job.reject(error) }
        queue.jobs.shift()
      }
      queue.running = false
      if (queues.get(sessionId) === queue) queues.delete(sessionId)
    })()
  }
  const links: ChatBrowserLinks = {
    open(sessionId: SessionId, url: string): Promise<void> {
      const owner = openers.get(sessionId)
      if (owner === undefined) return Promise.reject(new Error('当前会话的浏览器工作台尚未就绪，请稍后重试'))
      let queue = queues.get(sessionId)
      if (queue === undefined) {
        queue = { owner, jobs: [], running: false, cancelled: false, sequence: 0 }
        queues.set(sessionId, queue)
      }
      if (queue.jobs.length >= MAX_QUEUED_LINKS) {
        return Promise.reject(new Error('待打开的链接过多，请等待当前链接完成后重试'))
      }
      const click = owner.clickState()
      const promise = new Promise<void>((resolve, reject) => {
        queue.jobs.push({ url, click, sequence: ++queue.sequence, resolve, reject })
      })
      drain(sessionId, queue)
      return promise
    },
  }
  ctx.provide('chatBrowserLinks', links)
  const controllerFor = (sessionId: string) => {
    let controller = controllers.get(sessionId)
    if (controller === undefined) {
      controller = new BrowserMirrorController(sessionId, undefined,
        (request, signal) => connection.api.browser.control(request, signal), desktopBrowserPresentation() !== null)
      controllers.set(sessionId, controller)
    }
    return controller
  }
  const face = (sessionId: string): BrowserMirrorInjected => {
    const controller = controllerFor(sessionId)
    return {
      hooks: { browserMirror: controller.view },
      start: () => controller.start(),
      ensureTab: () => controller.ensureTab(),
      command: command => controller.command(command),
      openUrl: url => controller.openUrl(url),
      registerLinkOpener,
      retry: () => { controller.retry() },
    }
  }
  ctx.slots.inject('workbench.browser', () => {
    const dispose = ctx.slots.register({
      name: 'workbench.browser', locale: NS,
      inject: face,
    }, BrowserMirror)
    return () => {
      dispose()
      for (const controller of controllers.values()) controller.stop()
      controllers.clear()
      openers.clear()
      for (const [sessionId, queue] of queues) cancelQueue(sessionId, queue)
    }
  })
  ctx.slots.inject('workbench.browser.tabs', () => ctx.slots.register({
    name: 'workbench.browser.tabs', locale: NS, inject: face,
  }, BrowserTabs))
}
