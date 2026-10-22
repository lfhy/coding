/**
 * 渠道级出站选择：直连、内置代理池或自定义代理。
 *
 * 出站属于渠道自己的设置，代理池只回答「池是否启用」：池规则为直连时，
 * 这里选择「内置代理池」的渠道也按直连处理。组件只呈现当前已存值和写入
 * 回调，写入路径由模型页 store 拥有。
 */

import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import type { OutboundModeView } from 'coding-api-remotes/client'
import type { en } from './locales.ts'
import styles from './ModelsSection.module.css'

/** Props of {@link ChannelOutboundRow}. */
export interface ChannelOutboundRowProps {
  /** 当前渠道已保存的出站选择。 */
  value: OutboundModeView
  /** 设置只读或页面未就绪时禁用写入。 */
  disabled: boolean
  /** 模型分区文案。 */
  t: (key: keyof typeof en) => string
  /** 写入选择；返回诊断文本表示失败，undefined 表示成功。 */
  onSave: (mode: OutboundModeView) => Promise<string | undefined>
}

/**
 * 渲染一个渠道的出站选择与保存反馈。
 * @param props - 当前选择、禁用状态、文案与写入回调。
 * @returns 出站选择行。
 */
export function ChannelOutboundRow(props: ChannelOutboundRowProps): ReactNode {
  const { value, disabled, t, onSave } = props
  const [mode, setMode] = useState<OutboundModeView['mode']>(value.mode)
  const [customUrl, setCustomUrl] = useState(value.customUrl ?? '')
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<string | undefined>(undefined)

  // 保存成功后父级快照会重画本行；切到「自定义代理」只是展开地址输入，
  // 尚未写入，因此本地模式要先于父级生效。
  useEffect(() => { setMode(value.mode) }, [value.mode])

  /** 提交一次选择；失败文本留在行内，不打断页面。 */
  const save = (next: OutboundModeView): void => {
    if (busy) return
    setBusy(true)
    setFailure(undefined)
    void onSave(next).then(
      (message) => { setFailure(message) },
      () => { setFailure(t('channelOutboundFailed')) },
    ).finally(() => { setBusy(false) })
  }

  const selectSegment = (next: 'direct' | 'pool'): void => {
    setMode(next)
    save({ mode: next })
  }
  const applyCustom = (): void => { save({ mode: 'custom', customUrl: customUrl.trim() }) }

  return <div className={styles['field']}>
    <span className={styles['fieldLabel']}>{t('channelOutbound')}</span>
    <div className={styles['outboundSegmented']} role="group" aria-label={t('channelOutbound')}>
      <button type="button" className={styles['outboundSegment']} aria-pressed={mode === 'direct'}
        disabled={disabled || busy} onClick={() => { selectSegment('direct') }}>{t('channelOutboundDirect')}</button>
      <button type="button" className={styles['outboundSegment']} aria-pressed={mode === 'pool'}
        disabled={disabled || busy} onClick={() => { selectSegment('pool') }}>{t('channelOutboundPool')}</button>
      <button type="button" className={styles['outboundSegment']} aria-pressed={mode === 'custom'}
        disabled={disabled || busy} onClick={() => { setMode('custom'); setFailure(undefined) }}>{t('channelOutboundCustom')}</button>
    </div>
    {mode === 'custom' ? <div className={styles['outboundCustomRow']}>
      <input className={styles['input']} value={customUrl} placeholder="http://proxy.example:8080"
        aria-label={t('channelOutboundUrl')} disabled={disabled || busy}
        onChange={(event) => { setCustomUrl(event.target.value) }} />
      <button type="button" className={styles['secondaryButton']}
        disabled={disabled || busy || customUrl.trim().length === 0}
        onClick={applyCustom}>{t('channelOutboundApply')}</button>
    </div> : null}
    {failure === undefined ? null : <p role="alert" className={styles['error']}>{failure}</p>}
  </div>
}
