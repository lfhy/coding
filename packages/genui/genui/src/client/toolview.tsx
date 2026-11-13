/** render_ui 的结果只在工具行显示，不创建或同步额外面板。 */
import { useMemo } from 'react'
import type {} from 'coding-client-runtime/client'
import type { ToolCallViewProps } from 'coding-client-ui-tool/client'
import { toolDisplayDescription } from 'coding-tools/display-description'
import { ExportableGenuiBlock } from './artifact/ExportableGenuiBlock.tsx'
import { ErrorBoundary } from './ErrorBoundary.tsx'
import { repairGenuiSpec } from './guard.ts'
import { useT } from './i18n/index.ts'
import { toolStateKey } from './interaction-store.ts'
import css from './GenuiBlock.module.css'

/** 仅从同次调用的冻结参数读取说明；旧记录不使用调用标识作为兜底文案。 */
function displayDescription(block: ToolCallViewProps['block']): string | undefined {
  const raw = 'kind' in block ? block.call?.argsRaw : block.argsRaw
  if (raw === undefined) return undefined
  try {
    return toolDisplayDescription(JSON.parse(raw) as unknown)
  } catch {
    return undefined
  }
}

/**
 * 按工具结果 meta 渲染卡片；无合法结果时展示调用说明与本地化状态。
 * @param props - 工具调用、结果及所属会话。
 * @returns 工具卡片或紧凑摘要；历史 panel 字段不改变显示位置。
 */
export function GenuiToolView({ block, sessionId }: ToolCallViewProps) {
  const t = useT()
  const description = displayDescription(block)
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
