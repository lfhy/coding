/** 技能工具行只读取冻结的调用与结果；完整说明保留在可展开的正文中。 */

import { useState, type KeyboardEvent, type ReactNode } from 'react'
import {
  IconChevronDownOutline14, IconInspectOutline12, IconSkillOutline16, StateDot,
} from 'coding-client-ui-primitives'
import type { ToolCallViewProps } from 'coding-client-ui-tool/client'
import type { PropsLocale } from 'coding-client-ui-slots'
import { toolDisplayDescription } from 'coding-tools/display-description'
import css from './SkillRow.module.css'

/** 仅从持久调用切片派生的工具行生命周期。 */
type SkillRowState = 'running' | 'ok' | 'error' | 'stopped'

/** 工具视图载荷与本包语言席位。 */
type SkillRowProps = ToolCallViewProps & PropsLocale<'skill'>

/** 可回放的紧凑技能行数据。 */
interface SkillRowModel {
  readonly name: string
  readonly displayDescription: string | undefined
  readonly output: string | null
  readonly errorSummary: string | null
  readonly state: SkillRowState
}

/** 错误摘要只取首行，完整内容保留在展开区。 */
function firstLine(text: string): string {
  const newline = text.indexOf('\n')
  return newline === -1 ? text : text.slice(0, newline)
}

/** 调用参数可能来自流式截断或旧记录，不能把原始 JSON 放到聊天摘要。 */
function skillArgs(argsRaw: string): unknown {
  try {
    return JSON.parse(argsRaw) as unknown
  } catch {
    return undefined
  }
}

/** 按通用工具行契约展开持久结果；与 ui-tool 的 resultText 保持一致。 */
function resultText(block: ToolCallViewProps['block']): string | null {
  if (!('kind' in block)) return null
  const parts: string[] = []
  for (const item of block.content) {
    parts.push(item.type === 'text' ? item.text : JSON.stringify(item, null, 2))
  }
  if (parts.length === 0 && block.error !== undefined) {
    parts.push(`${block.error.name}: ${block.error.code}`)
  }
  return parts.join('\n') || null
}

/** 仅从冻结记录派生展示状态，不读取当前技能目录。 */
function skillRowModel(block: ToolCallViewProps['block'], t: SkillRowProps['t']): SkillRowModel {
  const settled = 'kind' in block
  const argsRaw = (settled ? block.call?.argsRaw : block.argsRaw) ?? ''
  const args = skillArgs(argsRaw)
  const rawName = typeof args === 'object' && args !== null && !Array.isArray(args)
    ? (args as Record<string, unknown>).name : undefined
  const state: SkillRowState = !settled
    ? 'running'
    : block.error?.code === 'interrupted'
      ? 'stopped'
      : block.isError ? 'error' : 'ok'
  const output = resultText(block)
  return {
    name: typeof rawName === 'string' && rawName.trim() !== '' ? firstLine(rawName) : t('row.unnamed'),
    displayDescription: toolDisplayDescription(args, 'skill'),
    output,
    errorSummary: state === 'error' && output !== null ? firstLine(output) : null,
    state,
  }
}

/** 错误与中断态替换行首图标。 */
function leadingFor(state: SkillRowState): ReactNode {
  switch (state) {
    case 'error': return <StateDot state="error" />
    case 'stopped': return <StateDot state="warning" />
    default: return <IconSkillOutline16 size={14} />
  }
}

/** 可展开时在悬停或展开状态显示箭头。 */
function disclosureLeading(state: SkillRowState, open: boolean, expandable: boolean): ReactNode {
  if (open) return <IconChevronDownOutline14 className={css.chevron} />
  const icon = leadingFor(state)
  if (!expandable) return icon
  return (
    <>
      <span className={css.iconIdle}>{icon}</span>
      <IconChevronDownOutline14 className={`${css.chevron} ${css.chevronHover}`} />
    </>
  )
}

/** 为仅靠颜色区分的状态提供屏幕阅读器文案。 */
function stateStatus(state: SkillRowState, t: SkillRowProps['t']): string | null {
  switch (state) {
    case 'running': return t('row.running')
    case 'error': return t('row.failed')
    case 'stopped': return t('row.stopped')
    default: return null
  }
}

/**
 * 把一次技能调用展示为摘要行和可展开的说明正文。
 * @param props - 键控工具视图载荷及技能语言席位。
 * @returns 独立的技能工具行。
 */
export function SkillRow({ block, inspect, t }: SkillRowProps) {
  const model = skillRowModel(block, t)
  const [expanded, setExpanded] = useState(false)
  const expandable = model.output !== null
  const open = expanded && expandable
  const status = stateStatus(model.state, t)
  const summary = model.errorSummary ?? model.name
  const toggleExpand = (): void => {
    setExpanded(value => !value)
  }
  const toggleFromKeyboard = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (!expandable || (event.key !== 'Enter' && event.key !== ' ')) return
    event.preventDefault()
    toggleExpand()
  }
  const disclosureProps = expandable ? {
    role: 'button' as const,
    tabIndex: 0,
    'aria-expanded': open,
    onClick: toggleExpand,
    onKeyDown: toggleFromKeyboard,
  } : {}
  const leading = disclosureLeading(model.state, open, expandable)
  return (
    <div className={css.card} data-tool="skill" data-state={model.state}>
      {model.displayDescription !== undefined && (
        <div className={css.description}>{model.displayDescription}</div>
      )}
      <div
        className={css.row}
        data-expandable={expandable || undefined}
        {...disclosureProps}
      >
        <span className={css.leading}>{leading}</span>
        {status !== null ? <span className={css.visuallyHidden}>{status}</span> : null}
        <span className={css.title}>Skill</span>
        <span className={css.separator} aria-hidden />
        <span className={model.errorSummary === null ? css.summary : `${css.summary} ${css.errorSummary}`}>
          {summary}
        </span>
      </div>
      {open ? (
        <div className={css.bodyWrap}>
          <section className={css.instructionsCard} aria-label={t('row.instructions')}>
            <div className={css.instructionsHeader}>{t('row.instructions')}</div>
            <pre className={css.instructions} data-error={model.state === 'error' || undefined}>{model.output}</pre>
          </section>
          {inspect !== undefined ? (
            <button type="button" className={css.inspectButton} onClick={inspect}>
              <IconInspectOutline12 />
              Inspect
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}
