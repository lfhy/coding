/** render_ui 的结果只在工具行显示，不创建或同步额外面板。 */
import { useMemo } from 'react'
import type {} from 'coding-client-runtime/client'
import type { ToolCallViewProps } from 'coding-client-ui-tool/client'
import { ExportableGenuiBlock } from './artifact/ExportableGenuiBlock.tsx'
import { ErrorBoundary } from './ErrorBoundary.tsx'
import { repairGenuiSpec } from './guard.ts'
import { useT } from './i18n/index.ts'
import { toolStateKey } from './interaction-store.ts'
import css from './GenuiBlock.module.css'

/** 仅回放已结算旧记录里的说明；新调用依靠卡片标题和静态状态。 */
function legacyDescription(block: ToolCallViewProps['block'], toolName: string): string | undefined {
  if (toolName !== 'render_ui' || !('kind' in block)) return undefined
  const raw = block.call?.argsRaw
  if (raw === undefined) return undefined
  try {
    const args = JSON.parse(raw) as unknown
    if (typeof args !== 'object' || args === null || Array.isArray(args)) return undefined
    const value = (args as Record<string, unknown>).display_description
    return typeof value === 'string' && value.trim() !== '' && value.length <= 160 ? value.trim() : undefined
  } catch {
    return undefined
  }
}

/**
 * 按工具结果 meta 渲染卡片；无合法结果时展示本地化状态，旧日志可附历史说明。
 * @param props - 工具调用、结果及所属会话。
 * @returns 工具卡片或紧凑摘要；历史 panel 字段不改变显示位置。
 */
export function GenuiToolView({ block, sessionId, toolName }: ToolCallViewProps) {
  const t = useT()
  const description = legacyDescription(block, toolName)
  const status = !('kind' in block) ? t('tool.running')
    : block.error?.code === 'interrupted' ? t('tool.stopped')
      : block.isError ? t('tool.failed') : t('tool.empty')
  const meta = 'meta' in block ? block.meta : undefined
  const spec = useMemo(() => (meta === undefined ? null : repairGenuiSpec(meta)), [meta])
  if (spec === null || spec.items.length === 0) {
    return (
      <div className={css.toolFallback} data-genui-tool>
        <span className={css.toolFallbackTitle}>{t('tool.title')}</span>
        {description !== undefined && <span className={css.toolFallbackDescription}>{description}</span>}
        <span className={css.toolFallbackMeta} role="status">{status}</span>
      </div>
    )
  }
  return (
    <div className={css.tool} data-genui-tool>
      {description !== undefined && <div className={css.toolDescription}>{description}</div>}
      {'kind' in block && block.isError && <div className={css.toolError} role="alert">{t('tool.failed')}</div>}
      <ErrorBoundary label={t('tool.title')}>
        <ExportableGenuiBlock spec={spec} stateKey={toolStateKey(sessionId, block.callId)} />
      </ErrorBoundary>
    </div>
  )
}
