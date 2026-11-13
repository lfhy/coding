/** 停止和移除操作的本地化卡片。 */

import {
  IconInspectOutline12, IconStopFill16, IconTrashOutline16, StateDot,
} from 'coding-client-ui-primitives'
import type { PropsLocale } from 'coding-client-ui-slots'
import type { ToolCallViewProps } from 'coding-client-ui-tool/client'
import { cordisActionCard } from './card-model.ts'
import css from './CordisRunRow.module.css'

/** 键控工具视图提供的操作卡片载荷。 */
export type CordisActionRowProps = ToolCallViewProps & PropsLocale<'cordis'>

/** 展示一次停止或移除操作及其持久结果。 */
export function CordisActionRow({ toolName, block, inspect, t }: CordisActionRowProps) {
  const card = cordisActionCard(block)
  const remove = toolName === 'cordis_undefine'
  const summary = card.errorSummary ?? t('row.unknownTarget')

  return (
    <div className={css.card} data-tool={toolName} data-state={card.state}>
      {card.displayDescription !== undefined && <div className={css.description}>{card.displayDescription}</div>}
      <div className={css.row}>
        <span className={css.icon}>
          {card.state === 'error'
            ? <StateDot state="error" />
            : card.state === 'stopped'
              ? <StateDot state="warning" />
              : remove ? <IconTrashOutline16 size={14} /> : <IconStopFill16 size={14} />}
        </span>
        <span className={css.title}>{t(remove ? 'row.removeTitle' : 'row.stopTitle')}</span>
        <span className={css.separator} aria-hidden />
        <span className={card.errorSummary === null ? css.summary : css.error}>{summary}</span>
        {inspect !== undefined && (
          <button type="button" className={css.inspect} aria-label="Inspect" onClick={inspect}>
            <IconInspectOutline12 />
          </button>
        )}
      </div>
      {card.output !== null && <pre className={css.output}>{card.output}</pre>}
    </div>
  )
}
