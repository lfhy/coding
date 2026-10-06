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
  const openers = new Map<string, (url: string, isCurrent: () => boolean) => Promise<void>>()
  const inFlight = new Map<string, { url: string; promise: Promise<void> }>()
  const registerLinkOpener = (sessionId: string, open: (url: string, isCurrent: () => boolean) => Promise<void>) => {
    openers.set(sessionId, open)
    return () => {
      if (openers.get(sessionId) !== open) return
      openers.delete(sessionId)
      inFlight.delete(sessionId)
    }
  }
  const links: ChatBrowserLinks = {
    open(sessionId: SessionId, url: string): Promise<void> {
      const owner = openers.get(sessionId)
      if (owner === undefined) return Promise.reject(new Error('当前会话的浏览器工作台尚未就绪，请稍后重试'))
      const pending = inFlight.get(sessionId)
      if (pending !== undefined) return pending.url === url ? pending.promise
        : Promise.reject(new Error('浏览器正在打开另一链接，请稍后重试'))
      const promise = Promise.resolve().then(async () => {
        if (openers.get(sessionId) !== owner) throw new Error('会话已切换，请在当前会话重试')
        await owner(url, () => openers.get(sessionId) === owner)
        if (openers.get(sessionId) !== owner) throw new Error('会话已切换，请在当前会话重试')
      }).finally(() => { if (inFlight.get(sessionId)?.promise === promise) inFlight.delete(sessionId) })
      inFlight.set(sessionId, { url, promise })
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
      inFlight.clear()
    }
  })
  ctx.slots.inject('workbench.browser.tabs', () => ctx.slots.register({
    name: 'workbench.browser.tabs', locale: NS, inject: face,
  }, BrowserTabs))
}
