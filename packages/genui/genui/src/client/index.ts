/**
 * GenUI 浏览器入口：识别 gen-ui 与历史 dsh-ui 围栏，并注册工具行视图。
 * 未完成的正文在代码块原位显示加载提示，完整组件立即渲染；不创建额外面板。
 * @module coding-genui/client
 */
import type { Context } from '@deepseek-ai/cordis'
import type {} from 'coding-client-runtime/client'
import type { SessionId } from 'coding-session/types'
import { createElement } from 'react'
import type { ToolCallViewProps } from 'coding-client-ui-tool/client'
import { installDomFenceRenderer } from './dom-fence.tsx'
import { createFileLinkAvailability, withFileLinkContext, type FileLinkCordisContext } from './file-link-context.tsx'
import { GenuiToolView } from './toolview.tsx'
import { mountAchievementToasts } from './achievement-toast.tsx'
import { bridgeHostLocale } from './i18n/index.ts'
import { assetUrl } from './asset-loader.ts'

/**
 * 低优先级预取懒引擎；不支持 prefetch 的浏览器仍由按需加载覆盖。
 * @returns 不等待资源下载，也不阻塞首屏。
 */
export function prefetchGenuiAssets(): void {
  if (typeof document === 'undefined') return
  for (const file of ['mermaid.js', 'three.js']) {
    if (document.head.querySelector(`link[rel="prefetch"][href="${assetUrl(file)}"]`) !== null) continue
    const link = document.createElement('link')
    link.rel = 'prefetch'
    link.as = 'script'
    link.href = assetUrl(file)
    document.head.appendChild(link)
  }
}

/** 内联围栏的动作发送到所属会话，并要求用同一规范围栏名返回更新内容。 */
function sendInlineGenuiAction(ctx: Context, sessionId: SessionId, action: string, payload: Record<string, unknown>): void {
  const scoped = ctx.sessions.scope(sessionId)
  const conversation = scoped?.get('conversation')
  if (conversation === undefined) return
  const payloadText = Object.keys(payload).length === 0
    ? ''
    : ` 组件数据: ${JSON.stringify(payload)}`
  void conversation.send(`[genui-action] ${action}。用户刚刚在界面中触发了动作 "${action}"，请根据组件数据执行相应操作，并用 gen-ui 输出更新后的界面。${payloadText}`).catch(() => {
    // 会话已销毁或发送失败时不禁用现有交互，也不记录可能含隐私的 payload。
  })
}

/**
 * 安装围栏与工具行渲染；只组合消息内内容，不注册 dock 或 slash command。
 * @param ctx - 拥有当前插件生命周期的浏览器上下文。
 * @returns 卸载观察器、工具行和本地化注册的清理函数。
 */
export function apply(ctx: Context): () => void {
  const localeDispose = bridgeHostLocale(ctx)
  const fileLinkAvailability = createFileLinkAvailability(ctx as unknown as FileLinkCordisContext)
  const disposers: Array<() => void> = [
    localeDispose,
    installDomFenceRenderer(ctx, (sessionId, action, payload) => {
      sendInlineGenuiAction(ctx, sessionId, action, payload)
    }, fileLinkAvailability),
  ]
  prefetchGenuiAssets()
  disposers.push(mountAchievementToasts())
  disposers.push(ctx.slots.inject('tool.call.toolview', () => ctx.slots.register({
    name: 'tool.call.toolview',
    key: 'render_ui',
  }, (props: ToolCallViewProps) => withFileLinkContext(
    ctx as unknown as FileLinkCordisContext,
    fileLinkAvailability,
    props.sessionId,
    false,
    createElement(GenuiToolView, props),
  ))))
  return () => {
    for (const dispose of disposers) dispose()
  }
}

/** 只有工具行注册和会话动作依赖宿主服务；不再依赖输入命令或面板生命周期。 */
export const inject = ['slots', 'sessions']
