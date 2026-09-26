import { useRef, useState, type KeyboardEvent } from 'react'
import clsx from 'clsx'
import type { ChatViewSlotProps } from '../contract/slots.ts'
import css from './ConversationAnchorRail.module.css'

interface AnchorMark {
  readonly key: string
  readonly title: string
  readonly preview: string
  /** 父级测量的可见轨道内像素位置，不是消息序号。 */
  readonly position: number
}

export interface ConversationAnchorRailProps {
  readonly marks: readonly AnchorMark[]
  readonly activeKey: string | null
  /** 不包含底部 sticky 输入区的可见高度。 */
  readonly trackHeight: number
  readonly compact: boolean
  readonly onJump: (key: string) => void
  readonly t: ChatViewSlotProps['t']
}

/** 只呈现父级给定的位置和当前项；滚动及定位归 ChatView 管理。 */
export function ConversationAnchorRail({
  marks, activeKey, trackHeight, compact, onJump, t,
}: ConversationAnchorRailProps) {
  const [previewKey, setPreviewKey] = useState<string | null>(null)
  const [rovingKey, setRovingKey] = useState<string | null>(null)
  const [expanded, setExpanded] = useState(false)
  const compactTrigger = useRef<HTMLButtonElement>(null)
  const activeIndex = marks.findIndex(mark => mark.key === activeKey)
  const rovingIndex = marks.findIndex(mark => mark.key === rovingKey)
  const tabIndex = rovingIndex < 0 ? Math.max(0, activeIndex) : rovingIndex
  const previewMark = marks.find(mark => mark.key === previewKey) ?? null

  if (marks.length === 0) return null
  const hitHeight = Math.max(4, Math.min(18, Math.floor((trackHeight - 16) / Math.max(1, marks.length - 1))))

  const closeCompact = (): void => {
    setExpanded(false)
    compactTrigger.current?.focus({ preventScroll: true })
  }

  const jump = (key: string): void => {
    if (compact) closeCompact()
    else setExpanded(false)
    onJump(key)
    setPreviewKey(null)
  }

  const dismiss = (event: KeyboardEvent): void => {
    if (event.key === 'Escape') {
      setPreviewKey(null)
      if (compact && expanded) closeCompact()
      event.stopPropagation()
    }
  }

  if (compact) {
    return (
      <div className={css.slot} onKeyDown={dismiss}>
        <div className={css.compact}>
          <button
            ref={compactTrigger}
            type="button"
            className={css.compactTrigger}
            aria-label={t('chat.anchors.compact')}
            aria-expanded={expanded}
            aria-controls="conversation-anchor-list"
            onClick={() => { setExpanded(value => !value) }}
          >
            <span className={css.compactGlyph} aria-hidden="true">☰</span>
          </button>
          {expanded && (
            <div id="conversation-anchor-list" className={css.compactPanel}>
              <div className={css.compactHeading}>
                <span>{t('chat.anchors.label')}</span>
                <button type="button" className={css.close} aria-label={t('chat.anchors.close')} onClick={closeCompact}>×</button>
              </div>
              <div className={css.compactList}>
                {marks.map((mark, index) => (
                  <button
                    key={mark.key}
                    type="button"
                    className={clsx(css.compactItem, mark.key === activeKey && css.compactItemActive)}
                    aria-label={t('chat.anchors.position', { current: index + 1, total: marks.length, title: mark.title })}
                    aria-current={mark.key === activeKey ? 'location' : undefined}
                    onClick={() => { jump(mark.key) }}
                  >
                    <span className={css.compactTitle}>{mark.title}</span>
                    <span className={css.compactPreview}>{mark.preview}</span>
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    )
  }

  return (
    <nav className={css.slot} aria-label={t('chat.anchors.label')} onKeyDown={dismiss}>
      <div className={css.track} style={{ height: Math.max(0, trackHeight) }}>
        {marks.map((mark, index) => (
          <button
            key={mark.key}
            type="button"
            className={clsx(css.mark, mark.key === activeKey && css.markActive)}
            style={{
              top: Math.max(8, Math.min(Math.max(8, trackHeight - 8), mark.position)),
              height: hitHeight,
            }}
            aria-label={t('chat.anchors.position', { current: index + 1, total: marks.length, title: mark.title })}
            aria-current={mark.key === activeKey ? 'location' : undefined}
            aria-describedby={previewKey === mark.key ? 'conversation-anchor-preview' : undefined}
            tabIndex={index === tabIndex ? 0 : -1}
            onMouseEnter={() => { setPreviewKey(mark.key) }}
            onMouseLeave={() => { setPreviewKey(current => current === mark.key ? null : current) }}
            onFocus={() => { setRovingKey(mark.key); setPreviewKey(mark.key) }}
            onBlur={() => { setPreviewKey(current => current === mark.key ? null : current) }}
            onClick={() => { jump(mark.key) }}
            onKeyDown={(event) => {
              const next = event.key === 'ArrowDown' ? index + 1
                : event.key === 'ArrowUp' ? index - 1
                  : event.key === 'Home' ? 0
                    : event.key === 'End' ? marks.length - 1 : null
              if (next === null) return
              event.preventDefault()
              const target = event.currentTarget.parentElement?.children.item(Math.max(0, Math.min(marks.length - 1, next)))
              if (target instanceof HTMLButtonElement) target.focus()
            }}
          >
            <span className={css.tick} aria-hidden="true" />
          </button>
        ))}
        {previewMark !== null && (
          <div
            id="conversation-anchor-preview"
            className={css.previewCard}
            role="tooltip"
            style={{ top: Math.max(60, Math.min(Math.max(60, trackHeight - 60), previewMark.position)) }}
          >
            <div className={css.previewTitle}>{previewMark.title}</div>
            <div className={css.previewText}>{previewMark.preview}</div>
          </div>
        )}
      </div>
    </nav>
  )
}
