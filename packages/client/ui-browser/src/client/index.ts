/** 浏览器观测独立占用 workbench.browser；Host 页面不进入 Client DOM。 */

import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-open-in-app/client'
import { BrowserMirrorController } from './controller.ts'
import { BrowserMirror, type BrowserMirrorInjected } from './BrowserMirror.tsx'
import { en, NS, zh, type BrowserMirrorKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** 浏览器画面区的展示文案。 */
    'browser-mirror': BrowserMirrorKey
  }
}

/** 插件只读取 slot 与 locale，不需 Host 控制权限。 */
export const inject = ['slots', 'locale']

/**
 * 注册每会话只读截图贡献；slot 消失时销毁会话控制器。
 * @param ctx - Client 插件上下文。
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-browser: dictionaries')
  const controllers = new Map<string, BrowserMirrorController>()
  ctx.slots.inject('workbench.browser', () => {
    const dispose = ctx.slots.register({
      name: 'workbench.browser', locale: NS,
      inject: (sessionId): BrowserMirrorInjected => {
        let controller = controllers.get(sessionId)
        if (controller === undefined) {
          controller = new BrowserMirrorController(sessionId)
          controllers.set(sessionId, controller)
        }
        return {
          hooks: { browserMirror: controller.view },
          start: (onRevision) => {
            const stop = controller.start(onRevision)
            return () => {
              stop()
              if (controllers.get(sessionId) === controller) controllers.delete(sessionId)
            }
          },
          retry: () => { controller.retry() },
        }
      },
    }, BrowserMirror)
    return () => {
      dispose()
      for (const controller of controllers.values()) controller.stop()
      controllers.clear()
    }
  })
}
