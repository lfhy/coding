/** 通用设置中的模型提供方请求 UA 输入行。 */
import { useEffect, useRef, useState } from 'react'
import type { SnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { ModelUserAgentState } from './model-user-agent.ts'
import css from './ModelUserAgentRow.module.css'

/** 注册侧提供的状态与持久化动作。 */
export interface ModelUserAgentRowInjected {
  hooks: { userAgent: SnapshotStore<ModelUserAgentState> }
  save: (value: string) => Promise<boolean>
}

/** 通用设置行的完整 props。 */
export type ModelUserAgentRowProps = PropsRuntime<'settings.general.item'>
  & PropsLocale<'settings.models'> & InjectFace<ModelUserAgentRowInjected>

/**
 * 校验单一 HTTP UA 标头值；空白由表单的恢复默认操作处理。
 * @param value - 用户输入。
 * @returns 可直接作为 UA 标头发送时为 true。
 */
export function validModelUserAgent(value: string): boolean {
  return value.length > 0 && value.length <= 256 && /^[\x21-\x7E](?:[\x20-\x7E]*[\x21-\x7E])?$/.test(value)
}

/**
 * 呈现模型请求 UA；编辑中的草稿不会被后台设置更新覆盖。
 * @param props - 设置行的组合属性。
 * @returns 可编辑的通用设置行。
 */
export function ModelUserAgentRow({ useUserAgent, save, t }: ModelUserAgentRowProps) {
  const state = useUserAgent(snapshot => snapshot)
  const [draft, setDraft] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const revision = useRef(0)
  const value = draft ?? state.value
  const invalid = draft !== null && !validModelUserAgent(draft)
  const disabled = state.status !== 'ready' || !state.writable || state.saving || submitting
  useEffect(() => {
    if (state.status !== 'ready') setDraft(null)
  }, [state.status])

  return (
    <div className={css.row}>
      <div className={css.heading}>
        <label htmlFor="model-user-agent" className={css.title}>{t('userAgentTitle')}</label>
        <p className={css.desc}>{t('userAgentDescription')}</p>
      </div>
      {state.status === 'unavailable' ? <p role="status" className={css.hint}>{t('userAgentUnavailable')}</p> : (
        <div className={css.controls}>
          <input
            id="model-user-agent" type="text" className={css.input} value={value}
            disabled={disabled} maxLength={256} spellCheck={false} autoComplete="off"
            aria-invalid={invalid || undefined}
            aria-describedby="model-user-agent-hint"
            onChange={(event) => { revision.current++; setDraft(event.target.value) }}
          />
          <p id="model-user-agent-hint" className={invalid ? css.error : css.hint}>
            {invalid ? t('userAgentInvalid') : t('userAgentHint')}
          </p>
          {state.error ? <p role="alert" className={css.error}>{t('userAgentFailed')}</p> : null}
          {!state.writable && state.status === 'ready' ? <p role="status" className={css.hint}>{t('readOnly')}</p> : null}
          <div className={css.actions}>
            <button type="button" disabled={disabled || !state.overridden} onClick={() => {
              const submittedRevision = revision.current
              setSubmitting(true)
              void save('').then((ok) => {
                if (ok && revision.current === submittedRevision) setDraft(null)
              }).finally(() => { setSubmitting(false) })
            }}>{t('userAgentReset')}</button>
            <button type="button" disabled={disabled || draft === null || invalid || draft === state.value}
              onClick={() => {
                const submitted = draft
                if (submitted === null) return
                const submittedRevision = revision.current
                setSubmitting(true)
                void save(submitted).then((ok) => {
                  if (ok && revision.current === submittedRevision) setDraft(null)
                }).finally(() => { setSubmitting(false) })
              }}>{t(state.saving || submitting ? 'applying' : 'save')}</button>
          </div>
        </div>
      )}
    </div>
  )
}
