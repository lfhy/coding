/**
 * 预设描述的统一呈现：由 CSS 截断，只有真的被截断时才在悬浮时给出完整文本。
 * 预设描述由文件作者自行撰写、长度不受限；座位菜单与设置卡片共用这一段，
 * 保证两处的截断与提示行为一致。
 */

import { useLayoutEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { Tooltip } from 'coding-client-ui-primitives'

/** 截断用的行数枚举与观测逻辑无关；线数由调用方的 className 决定。 */
export interface PresetDescriptionProps {
  /** 已经本地化、准备渲染的描述文本。 */
  text: string
  /** 承载行数限制（-webkit-line-clamp）的类名。 */
  className?: string | undefined
  /** 悬浮提示的最大宽度；菜单与卡片各自给出不超过自身宽度的值。 */
  maxWidth: number
}

/**
 * 渲染一段会被截断的预设描述。
 * @param props - 见 {@link PresetDescriptionProps}。
 * @returns 描述元素；仅在文本被裁切时挂载完整内容的 tooltip。
 */
export function PresetDescription({ text, className, maxWidth }: PresetDescriptionProps): ReactNode {
  const ref = useRef<HTMLSpanElement | null>(null)
  const [truncated, setTruncated] = useState(false)
  useLayoutEffect(() => {
    const el = ref.current
    /* v8 ignore next -- the ref is attached before layout effects run. */
    if (el === null) return
    const measure = (): void => { setTruncated(el.scrollHeight > el.clientHeight) }
    measure()
    // 卡片与菜单的宽度都随窗口变化，因此不能只量一次。
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(measure)
    observer.observe(el)
    return () => { observer.disconnect() }
  }, [text])
  return (
    // 宽度上限贴着调用方的容器：默认半个视口的气泡会把描述喷到菜单外面。
    <Tooltip label={text} side="bottom" delayMs={400} disabled={!truncated} maxWidth={maxWidth}>
      {/* 空的 title 阻止原生提示再爬上来：被截断的描述只回一个气泡，不是两个。 */}
      <span ref={ref} className={className} title="">{text}</span>
    </Tooltip>
  )
}
