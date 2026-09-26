/** 浏览器观测独立占用 workbench.browser；Host 页面不进入 Client DOM。 */

import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-open-in-app/client'
import { BrowserMirrorController } from './controller.ts'
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
  const controllerFor = (sessionId: string) => {
    let controller = controllers.get(sessionId)
    if (controller === undefined) {
      controller = new BrowserMirrorController(sessionId, undefined,
        (request, signal) => connection.api.browser.control(request, signal))
      controllers.set(sessionId, controller)
    }
    return controller
  }
  const face = (sessionId: string): BrowserMirrorInjected => {
    const controller = controllerFor(sessionId)
    return {
      hooks: { browserMirror: controller.view },
      start: onRevision => controller.start(onRevision),
      ensureTab: () => controller.ensureTab(),
      command: command => controller.command(command),
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
    }
  })
  ctx.slots.inject('workbench.browser.tabs', () => ctx.slots.register({
    name: 'workbench.browser.tabs', locale: NS, inject: face,
  }, BrowserTabs))
}
