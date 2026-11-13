/** 话题选择只改变本地状态；发送由用户点击选项或确认按钮触发。 */
import { useRef, useState } from 'react'
import { IconSendOutline14, Toast } from 'coding-client-ui-primitives'
import { renderInline } from '../inline.ts'
import { useT } from '../i18n/index.ts'
import { useGenuiMessage } from '../message-context.ts'
import type { GenuiTopicGuide } from '../spec.ts'
import type { AnswersState } from './state.ts'
import css from '../GenuiBlock.module.css'

/** 原样发送所选预设文本，成功后锁定，失败时允许重试。 */
export function TopicGuideNode({ node, answers }: { node: GenuiTopicGuide; answers?: AnswersState | undefined }) {
  const t = useT()
  const sendMessage = useGenuiMessage()
  const [localSelected, setLocalSelected] = useState<number | null>(null)
  const [localSent, setLocalSent] = useState(false)
  const [sending, setSending] = useState(false)
  const [notice, setNotice] = useState(0)
  const pending = useRef(false)
  const optionsRef = useRef<Array<HTMLButtonElement | null>>([])
  const saved = answers?.topics[node.id]
  const selected = saved?.selected ?? localSelected
  const sent = saved?.sent === true || localSent
  const disabled = sendMessage === undefined || sending || sent

  const choose = (index: number): void => {
    if (disabled) return
    setLocalSelected(index)
    answers?.setTopic(node.id, { selected: index })
  }

  const send = async (index: number): Promise<void> => {
    if (disabled || pending.current) return
    const option = node.options[index]
    if (option === undefined) return
    pending.current = true
    setSending(true)
    try {
      await sendMessage(option.message)
      setLocalSent(true)
      answers?.setTopic(node.id, { selected: index, sent: true })
    } catch {
      setNotice(value => value + 1)
    } finally {
      pending.current = false
      setSending(false)
    }
  }

  return (
    <section className={css.topicGuide} aria-label={node.question}>
      <div className={css.topicQuestion}>{renderInline(node.question)}</div>
      <div className={css.topicOptions} role="radiogroup" aria-label={node.question}>
        {node.options.map((option, index) => (
          <button
            key={index}
            ref={(element) => { optionsRef.current[index] = element }}
            type="button"
            role="radio"
            aria-checked={selected === index}
            aria-label={option.label}
            className={`${css.topicOption} ${selected === index ? css.topicOptionSelected : ''}`}
            disabled={disabled}
            tabIndex={disabled ? -1 : selected === null ? (index === 0 ? 0 : -1) : (selected === index ? 0 : -1)}
            onClick={() => {
              choose(index)
              if (node.confirmLabel === undefined) void send(index)
            }}
            onKeyDown={(event) => {
              const next = event.key === 'ArrowDown' || event.key === 'ArrowRight'
                ? (index + 1) % node.options.length
                : event.key === 'ArrowUp' || event.key === 'ArrowLeft'
                  ? (index - 1 + node.options.length) % node.options.length
                  : event.key === 'Home' ? 0 : event.key === 'End' ? node.options.length - 1 : null
              if (next === null) return
              event.preventDefault()
              choose(next)
              optionsRef.current[next]?.focus()
            }}
          >
            <span className={css.topicIndicator} aria-hidden="true" />
            <span className={css.topicOptionText}>
              <span>{renderInline(option.label, false)}</span>
              <span className={css.topicMessage}>{option.message}</span>
            </span>
          </button>
        ))}
      </div>
      {node.confirmLabel !== undefined && (
        <button
          type="button"
          className={`${css.button} ${css.primary} ${css.topicConfirm}`}
          disabled={selected === null || disabled}
          onClick={() => { if (selected !== null) void send(selected) }}
        >
          <span>{renderInline(node.confirmLabel, false)}</span>
          <IconSendOutline14 />
        </button>
      )}
      {sent && <span className={css.topicSent} role="status">{t('block.topicSent')}</span>}
      {notice > 0 && <Toast key={notice} text={t('block.topicFailed')} onDone={() => { setNotice(0) }} />}
    </section>
  )
}
