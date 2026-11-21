/** 折叠展示渠道的出站与请求标头；此处只修改外层表单草稿。 */

import { useId, type ReactNode } from 'react'
import { OutboundSelect } from 'coding-client-ui-primitives'
import { MAX_USER_AGENT_LENGTH } from './user-agent.ts'
import type { en } from './locales.ts'
import styles from './ModelsSection.module.css'

/** 渠道出站草稿；字段只在 schema 声明时渲染。 */
type OutboundDraft = { mode: 'direct' | 'pool' | 'custom'; customUrl?: string }

/** 出站草稿里唯一会阻止保存的情况：自定义模式缺少合法 http(s) 地址。 */
export function outboundDraftFailure(value: unknown): 'channelOutboundInvalid' | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const record = value as { mode?: unknown; customUrl?: unknown }
  if (record.mode !== 'custom') return undefined
  return typeof record.customUrl === 'string' && /^https?:\/\//.test(record.customUrl)
    ? undefined
    : 'channelOutboundInvalid'
}

interface ChannelAdvancedFieldsProps {
  t: (key: keyof typeof en) => string
  disabled: boolean
  outbound: unknown
  outboundFailure: 'channelOutboundInvalid' | undefined
  onOutboundChange?: (next: OutboundDraft) => void
  userAgent: string
  userAgentFailure: 'userAgentInvalid' | undefined
  onUserAgentChange: (value: string) => void
}

/**
 * 显示渠道支持的高级字段，不自行写入设置或凭据。
 * @param props - 草稿、校验与写入外层草稿的回调。
 * @returns 高级设置折叠区。
 */
export function ChannelAdvancedFields(props: ChannelAdvancedFieldsProps): ReactNode {
  const { t, disabled, outbound, outboundFailure, onOutboundChange, userAgent, userAgentFailure, onUserAgentChange } = props
  const fieldId = useId()
  const outboundField = (): ReactNode => {
    const record = typeof outbound === 'object' && outbound !== null
      ? outbound as Record<string, unknown>
      : {}
    const storedMode = record['mode']
    const mode = storedMode === 'pool' || storedMode === 'custom' ? storedMode : 'direct'
    const customUrl = typeof record['customUrl'] === 'string' ? record['customUrl'] : ''
    return <div className={styles['field']}>
      <span className={styles['fieldLabel']}>{t('channelOutbound')}</span>
      <OutboundSelect
        value={{ mode, customUrl }}
        disabled={disabled}
        invalid={outboundFailure !== undefined}
        urlPlaceholder="http://proxy.example:8080"
        labels={{
          group: t('channelOutbound'),
          direct: t('channelOutboundDirect'),
          pool: t('channelOutboundPool'),
          custom: t('channelOutboundCustom'),
          url: t('channelOutboundUrl'),
        }}
        onChange={(next) => {
          onOutboundChange?.(next.mode === 'custom'
            ? { mode: 'custom', customUrl: next.customUrl ?? '' }
            : { mode: next.mode })
        }}
        onCustomUrlChange={(next) => { onOutboundChange?.({ mode: 'custom', customUrl: next }) }}
      />
      {outboundFailure === undefined ? null : <p className={styles['error']} role="alert">{t(outboundFailure)}</p>}
    </div>
  }
  return (
    <details className={styles['advanced']}>
      <summary className={styles['customizedSummary']}>{t('advancedSettings')}</summary>
      <div className={styles['customizedBody']}>
        {onOutboundChange === undefined ? null : outboundField()}
        <div className={styles['field']}>
          <span className={styles['fieldLabel']}>{t('userAgent')}</span>
          <input
            className={styles['input']}
            type="text"
            value={userAgent}
            placeholder={t('userAgentPlaceholder')}
            aria-label={t('userAgent')}
            aria-invalid={userAgentFailure !== undefined}
            aria-describedby={userAgentFailure === undefined ? undefined : `${fieldId}-user-agent-error`}
            disabled={disabled}
            maxLength={MAX_USER_AGENT_LENGTH}
            spellCheck={false}
            autoComplete="off"
            onChange={(event) => { onUserAgentChange(event.target.value) }}
          />
          {userAgentFailure === undefined
            ? <p className={styles['advancedHint']}>{t('userAgentHint')}</p>
            : <p id={`${fieldId}-user-agent-error`} className={styles['error']} role="alert">{t(userAgentFailure)}</p>}
        </div>
      </div>
    </details>
  )
}
