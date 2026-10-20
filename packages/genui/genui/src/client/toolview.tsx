/** render_ui 的结果只在工具行显示，不创建或同步额外面板。 */
import { useMemo } from 'react'
import type {} from 'coding-client-runtime/client'
import type { ToolCallViewProps } from 'coding-client-ui-tool/client'
import { ExportableGenuiBlock } from './artifact/ExportableGenuiBlock.tsx'
import { ErrorBoundary } from './ErrorBoundary.tsx'
import { repairGenuiSpec } from './guard.ts'
import { toolStateKey } from './interaction-store.ts'
import css from './GenuiBlock.module.css'

/**
 * 按工具结果 meta 渲染卡片；运行中及缺少合法 meta 的历史记录保留摘要。
 * @param props - 工具调用、结果及所属会话。
 * @returns 工具卡片或紧凑摘要；历史 panel 字段不改变显示位置。
 */
export function GenuiToolView({ toolName, block, sessionId }: ToolCallViewProps) {
  const meta = 'meta' in block ? block.meta : undefined
  const spec = useMemo(() => (meta === undefined ? null : repairGenuiSpec(meta)), [meta])
  if (spec === null || spec.items.length === 0) {
    return (
      <div className={css.toolFallback} data-genui-tool>
        <span className={css.toolFallbackTitle}>{toolName}</span>
        <span className={css.toolFallbackMeta}>{block.callId}</span>
      </div>
    )
  }
  return (
    <div className={css.tool} data-genui-tool>
      <ErrorBoundary label="工具卡片">
        <ExportableGenuiBlock spec={spec} stateKey={toolStateKey(sessionId, block.callId)} />
      </ErrorBoundary>
    </div>
  )
}
