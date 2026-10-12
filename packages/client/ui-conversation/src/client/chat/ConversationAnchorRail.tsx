import { useLayoutEffect, useRef, useState, type FocusEvent, type KeyboardEvent, type MouseEvent } from 'react'
import clsx from 'clsx'
import type { ChatViewSlotProps } from '../contract/slots.ts'
import css from './ConversationAnchorRail.module.css'

interface AnchorMark {
  readonly key: string
  readonly title: string
  readonly preview: string
}

export interface ConversationAnchorRailProps {
  readonly marks: readonly AnchorMark[]
  readonly activeKey: string | null
  /** 不包含底部 sticky 输入区的可见高度。 */
  readonly trackHeight: number
  readonly onJump: (key: string) => void
  readonly t: ChatViewSlotProps['t']
}

/** 使用父级标记及当前项；消息滚动与跳转仍归 ChatView 管理。 */
export function ConversationAnchorRail({
  marks, activeKey, trackHeight, onJump, t,
}: ConversationAnchorRailProps) {
  const [previewKey, setPreviewKey] = useState<string | null>(null)
  const [previewAnchor, setPreviewAnchor] = useState<{ right: number; centerY: number } | null>(null)
  const [interactionKey, setInteractionKey] = useState<string | null>(null)
  const [rovingKey, setRovingKey] = useState<string | null>(null)
  const railScroll = useRef<HTMLDivElement>(null)
  const previewCard = useRef<HTMLDivElement>(null)
  const activeIndex = marks.findIndex(mark => mark.key === activeKey)
  const interactionIndex = marks.findIndex(mark => mark.key === interactionKey)
  const rovingIndex = marks.findIndex(mark => mark.key === rovingKey)
  const tabIndex = rovingIndex < 0 ? Math.max(0, activeIndex) : rovingIndex
  const previewMark = marks.find(mark => mark.key === previewKey) ?? null

  useLayoutEffect(() => {
    if (marks.length < 2 || activeIndex < 0) return
    const rail = railScroll.current
    if (rail === null) return
    rail.scrollTop = Math.max(0, activeIndex * 10 + 5 - rail.clientHeight / 2)
  }, [activeIndex, marks.length, trackHeight])

  useLayoutEffect(() => {
    const card = previewCard.current
    if (card === null || previewAnchor === null) return
    card.style.left = `${Math.max(16, Math.min(previewAnchor.right + 8, window.innerWidth - card.offsetWidth - 16))}px`
    card.style.top = `${Math.max(16, Math.min(previewAnchor.centerY - card.offsetHeight / 2, window.innerHeight - card.offsetHeight - 16))}px`
  }, [previewAnchor])

  if (marks.length === 0) return null

  const showPreview = (event: MouseEvent<HTMLButtonElement> | FocusEvent<HTMLButtonElement>, key: string): void => {
    const rect = event.currentTarget.getBoundingClientRect()
    setInteractionKey(key)
    setPreviewKey(key)
    setPreviewAnchor({ right: rect.right, centerY: rect.top + rect.height / 2 })
  }

  const hidePreview = (key: string): void => {
    setInteractionKey(current => current === key ? null : current)
    setPreviewKey(current => current === key ? null : current)
  }

  const jump = (key: string): void => {
    onJump(key)
    setPreviewKey(null)
    setInteractionKey(null)
  }

  const dismiss = (event: KeyboardEvent): void => {
    if (event.key === 'Escape') {
      setPreviewKey(null)
      setInteractionKey(null)
      event.stopPropagation()
    }
  }

  if (marks.length < 2) return null

  return (
    <nav className={css.slot} aria-label={t('chat.anchors.label')} onKeyDown={dismiss}>
      <div className={css.track} style={{ height: Math.max(0, trackHeight) }}>
        <div ref={railScroll} className={css.railScroll} onScroll={(event) => {
          const focused = event.currentTarget.querySelector<HTMLButtonElement>('button:focus')
          if (focused === null) {
            setPreviewKey(null)
            setInteractionKey(null)
            return
          }
          const viewport = event.currentTarget.getBoundingClientRect()
          const rect = focused.getBoundingClientRect()
          if (rect.bottom <= viewport.top || rect.top >= viewport.bottom) {
            setPreviewKey(null)
            setInteractionKey(null)
            return
          }
          const index = [...event.currentTarget.children].indexOf(focused)
          const mark = marks[index]
          if (mark === undefined) return
          setInteractionKey(mark.key)
          setPreviewKey(mark.key)
          setPreviewAnchor({ right: rect.right, centerY: rect.top + rect.height / 2 })
        }}>
          {marks.map((mark, index) => (
            <button
              key={mark.key}
              type="button"
              className={clsx(css.mark,
                mark.key === activeKey && interactionIndex < 0 && css.markActive,
                index === interactionIndex && css.markFocused)}
              aria-label={t('chat.anchors.position', { current: index + 1, total: marks.length, title: mark.title })}
              aria-current={mark.key === activeKey ? 'location' : undefined}
              aria-describedby={previewKey === mark.key ? 'conversation-anchor-preview' : undefined}
              tabIndex={index === tabIndex ? 0 : -1}
              onMouseEnter={(event) => { showPreview(event, mark.key) }}
              onMouseLeave={() => { hidePreview(mark.key) }}
              onFocus={(event) => { setRovingKey(mark.key); showPreview(event, mark.key) }}
              onBlur={() => { hidePreview(mark.key) }}
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
              <span
                className={clsx(css.tick,
                  interactionIndex >= 0 && Math.abs(index - interactionIndex) === 1 && css.tickNear,
                  interactionIndex >= 0 && Math.abs(index - interactionIndex) === 2 && css.tickMid)}
                aria-hidden="true"
              />
            </button>
          ))}
        </div>
      </div>
      {previewMark !== null && previewAnchor !== null && (
        <div ref={previewCard} id="conversation-anchor-preview" className={css.previewCard} role="tooltip">
          <div className={css.previewTitle}>{previewMark.title}</div>
          <div className={css.previewText}>{previewMark.preview}</div>
        </div>
      )}
    </nav>
  )
}
