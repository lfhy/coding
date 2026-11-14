/** 回合活动行：具体进度优先，只有没有进度时才轮换装饰短语。 */
import { useEffect, useState } from 'react'
import type { ChatViewSlotProps } from '../contract/slots.ts'
import { formatRunDuration } from './message-chrome.ts'
import {
  pickTurnStatusPhrase, TURN_STATUS_ROTATE_MS, turnStatusLocale, turnStatusPhase, turnStatusPhrases,
} from './turn-status-phrases/index.ts'
import a11yCss from './accessibility.module.css'
import css from './TurnStatus.module.css'

interface TurnStatusProps {
  /** 运行中回合的起点；边界在窗口外时以本次挂载为起点。 */
  readonly startTime: number | null
  /** 已按优先级选出的具体进度；null 才启用随机短语。 */
  readonly label: string | null
  readonly t: ChatViewSlotProps['t']
}

/**
 * 显示回合进度，换标签不重置时钟，装饰元素不参与读屏播报。
 * @param props 已解析的进度、回合起点与所属视图的语言座位。
 * @returns 单行活动标签及超过起步门槛后的运行时长。
 */
export function TurnStatus({ startTime, label, t }: TurnStatusProps) {
  const [mountedAt] = useState(() => Date.now())
  const anchor = startTime ?? mountedAt
  const [elapsedMs, setElapsedMs] = useState(() => Math.max(0, Date.now() - anchor))
  useEffect(() => {
    const tick = (): void => { setElapsedMs(Math.max(0, Date.now() - anchor)) }
    tick()
    const id = setInterval(tick, 1000)
    return () => { clearInterval(id) }
  }, [anchor])

  const showClock = elapsedMs >= 15_000
  const phase = turnStatusPhase(elapsedMs)
  const showRandom = label === null
  const [phrase, setPhrase] = useState<string | null>(null)
  useEffect(() => {
    if (!showRandom) return
    const rotate = (): void => {
      setPhrase(previous => pickTurnStatusPhrase(turnStatusPhrases(phase, turnStatusLocale()), previous))
    }
    rotate()
    const id = setInterval(rotate, TURN_STATUS_ROTATE_MS)
    return () => { clearInterval(id) }
  }, [phase, showRandom])

  const text = label ?? phrase
  return (
    <div className={css.root} role="status" aria-live="polite" aria-atomic>
      <span className={css.spinner} aria-hidden />
      {text !== null && (
        <span key={text} className={css.label} title={text} aria-hidden={showRandom || undefined}>{text}</span>
      )}
      {showRandom && <span className={a11yCss.visuallyHidden}>{t('status.running')}</span>}
      {showClock && (
        <span className={css.clock} aria-hidden>{formatRunDuration(elapsedMs, t)}</span>
      )}
    </div>
  )
}
