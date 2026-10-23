/**
 * 出站三选一控件：直连、内置代理池或自定义代理。
 *
 * 模型渠道详情、代理池设置和联网搜索设置都渲染同一份选择语义，因此这里只做
 * 受控呈现：调用方持有值、文案与保存时机，控件不读任何服务、不写设置。
 * 自定义代理展开的地址输入与分段控件保持统一的 8px 间距。
 */

import { useId } from 'react'
import type { ReactNode } from 'react'
import css from './OutboundSelect.module.css'

/** 出站模式；与 Host 侧 `OutboundConfig` 的 `mode` 一致。 */
export type OutboundSelectMode = 'direct' | 'pool' | 'custom'

/** 受控值：自定义模式可携带尚未校验的地址草稿。 */
export interface OutboundSelectValue {
  mode: OutboundSelectMode
  customUrl?: string
}

/** 控件文案；由调用方从自己的字典取。 */
export interface OutboundSelectLabels {
  /** 分段控件与地址输入的可访问名称。 */
  group: string
  direct: string
  pool: string
  custom: string
  /** 自定义地址输入的标签。 */
  url: string
}

/** Props of {@link OutboundSelect}. */
export interface OutboundSelectProps {
  /** 当前选择。 */
  value: OutboundSelectValue
  /** 文案。 */
  labels: OutboundSelectLabels
  /** 设置只读或正在保存时禁用交互。 */
  disabled?: boolean
  /** 自定义地址当前不合法；只影响可访问状态，错误文案由调用方呈现。 */
  invalid?: boolean
  /** 地址输入的占位文本。 */
  urlPlaceholder?: string
  /** 报告下一次选择；自定义模式会带上已存的地址草稿。 */
  onChange: (next: OutboundSelectValue) => void
  /** 自定义地址的键入；由调用方决定是否即时校验。 */
  onCustomUrlChange: (url: string) => void
}

/**
 * 绘制出站三选一。
 * @param props - 当前值、文案、禁用状态与回调。
 * @returns 分段控件，以及自定义模式下的地址输入。
 */
export function OutboundSelect(props: OutboundSelectProps): ReactNode {
  const { value, labels, disabled = false, invalid = false, urlPlaceholder, onChange, onCustomUrlChange } = props
  const urlId = useId()
  const modes: readonly OutboundSelectMode[] = ['direct', 'pool', 'custom']
  return (
    <div className={css.outbound}>
      <div className={css.segmented} role="group" aria-label={labels.group}>
        {modes.map(mode => (
          <button
            key={mode}
            type="button"
            className={css.segment}
            aria-pressed={value.mode === mode}
            disabled={disabled}
            onClick={() => {
              onChange(mode === 'custom'
                ? { mode: 'custom', customUrl: value.customUrl ?? '' }
                : { mode })
            }}
          >
            {mode === 'direct' ? labels.direct : mode === 'pool' ? labels.pool : labels.custom}
          </button>
        ))}
      </div>
      {value.mode === 'custom'
        ? (
          <div className={css.customRow}>
            <label className={css.customLabel} htmlFor={urlId}>{labels.url}</label>
            <input
              id={urlId}
              className={css.customInput}
              type="text"
              value={value.customUrl ?? ''}
              placeholder={urlPlaceholder}
              aria-invalid={invalid || undefined}
              disabled={disabled}
              onChange={(event) => { onCustomUrlChange(event.target.value) }}
            />
          </div>
        )
        : null}
    </div>
  )
}
