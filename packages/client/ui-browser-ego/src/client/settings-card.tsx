/**
 * Agent 浏览器设置卡：设置命名空间 `ego-browser` 的浏览器半边。
 *
 * 卡片不持有 Host 字段的默认值或校验规则：它展示 Host 服务的有效值，草稿只在
 * 保存时经设置作用域写入，因此只读部署只用一行说明阻止误操作。卡片由设置页的
 * 插件槽位按命名空间派发；命名空间不可用时整张卡不出现。
 */

import { useState } from 'react'
import { IconChevronDownOutline14 } from 'coding-client-ui-icons'
import type { InjectFace, PropsLocale, PropsRuntime } from 'coding-client-ui-slots'
import type {} from 'coding-client-ui-settings-plugins/client'
import type { BrowserEgoKey } from './locales.ts'
import { NS } from './locales.ts'
import type { CardFieldState } from './card-form.ts'
import { FIELD_GROUPS, needsVideoTool, type FieldDescriptor } from './settings-fields.ts'
import type { EgoBrowserCardFace } from './settings-card-controller.ts'
import css from './settings-card.module.css'

/** 设置页插件槽位注入给卡片的属性。 */
export type EgoBrowserCardProps =
  PropsRuntime<'settings.plugin.item'>
  & PropsLocale<typeof NS>
  & InjectFace<EgoBrowserCardFace>

/** 控件共享的文案与动作；字段级文本由词典键取。 */
interface ControlCopy {
  t: (key: BrowserEgoKey) => string
  disabled: boolean
  onEdit: (text: string) => void
  onReset: () => void
}

/**
 * 字段标题：标签、覆盖徽标与恢复默认真实。
 * @param props - 字段文案、草稿状态与动作。
 * @returns 标题行。
 */
function FieldHead({ t, disabled, state, label, id, onReset }: Omit<ControlCopy, 'onEdit'> & {
  state: CardFieldState
  label: string
  id: string
}) {
  return (
    <div className={css.head}>
      <label className={css.label} htmlFor={id}>{label}</label>
      {state.overridden
        ? (
          <span className={css.badges}>
            <span className={css.badge}>{t('overridden')}</span>
            <button type="button" className={css.reset} disabled={disabled} onClick={onReset}>
              {t('reset')}
            </button>
          </span>
        )
        : null}
    </div>
  )
}

/** @returns 该控件形态下非法草稿的固定说明。 */
function invalidLabelKey(kind: FieldDescriptor['kind']): BrowserEgoKey {
  switch (kind) {
    case 'select': return 'invalidChoice'
    case 'number': return 'invalidNumber'
    case 'text': return 'invalidNumber'
    case 'toggle': return 'invalidNumber'
  }
}

/**
 * 渲染一个字段的控件。
 * @param props - 目录中的字段、草稿状态、文案与动作。
 * @returns 标签、控件与说明。
 */
function FieldControl({ descriptor, state, t, disabled, onEdit, onReset }: ControlCopy & {
  descriptor: FieldDescriptor
  state: CardFieldState
}) {
  const id = `ego-browser-setting-${descriptor.field}`
  return (
    <div className={css.field}>
      <FieldHead t={t} disabled={disabled} state={state} label={t(descriptor.label)} id={id}
        onReset={onReset} />
      {descriptor.kind === 'select'
        ? (
          <select id={id} className={state.invalid ? css.inputInvalid : css.select} value={state.text}
            disabled={disabled} aria-invalid={state.invalid || undefined}
            onChange={(event) => { onEdit(event.target.value) }}>
            {state.text === '' ? <option value="" disabled>{t('optionUnset')}</option> : null}
            {(descriptor.options ?? []).map(option => (
              <option key={option.value} value={option.value}>{t(option.label)}</option>
            ))}
          </select>
        )
        : descriptor.kind === 'toggle'
          ? (
            <span className={css.toggleRow}>
              <input id={id} type="checkbox" role="switch" className={css.toggle}
                checked={state.text === 'true'} disabled={disabled}
                onChange={(event) => { onEdit(event.target.checked ? 'true' : 'false') }} />
            </span>
          )
          : (
            <input id={id} type="text" className={state.invalid ? css.inputInvalid : css.input}
              value={state.text} disabled={disabled} aria-invalid={state.invalid || undefined}
              {...descriptor.kind === 'number' ? { inputMode: 'numeric' as const } : {}}
              onChange={(event) => { onEdit(event.target.value) }} />
          )}
      <p className={state.invalid ? css.invalid : css.hint}>
        {state.invalid ? t(invalidLabelKey(descriptor.kind)) : t(descriptor.hint)}
      </p>
      {descriptor.field === 'captureBackend' && needsVideoTool(state.text)
        ? <p className={css.note} role="note">{t('ffmpegDependency')}</p>
        : null}
    </div>
  )
}

/**
 * 渲染 Agent 浏览器设置卡。
 * @param props - 卡片快照、词典读取与表单动作。
 * @returns 可展开的设置卡；命名空间未服务时不渲染任何内容。
 */
export function EgoBrowserCard(props: EgoBrowserCardProps) {
  const [open, setOpen] = useState(false)
  const { t } = props
  const state = props.useEgoBrowserCard(snapshot => snapshot)
  if (!state.available) return null
  const disabled = !state.writable
  const title = t('title')
  return (
    <li className={css.card} data-open={open || undefined}>
      <button type="button" className={css.header} aria-expanded={open}
        aria-label={`${t(open ? 'collapseSettings' : 'expandSettings')}: ${title}`}
        onClick={() => { setOpen(!open) }}>
        <span className={css.headText}>
          <span className={css.name}>{title}</span>
          <span className={css.description}>{t('settingsDescription')}</span>
        </span>
        {state.dirty ? <span className={css.pending}>{t('unsaved')}</span> : null}
        <IconChevronDownOutline14 className={open ? css.chevronOpen : css.chevron} />
      </button>
      {open
        ? (
          <div className={css.body}>
            {!state.writable ? <p className={css.readOnly} role="status">{t('settingsReadOnly')}</p> : null}
            {FIELD_GROUPS.map(group => (
              <div key={group.title} className={css.group} role="group" aria-label={t(group.title)}>
                <h4 className={css.groupTitle}>{t(group.title)}</h4>
                {group.fields.map((descriptor) => {
                  const field = state.fields[descriptor.field]
                  return (
                    <FieldControl key={descriptor.field} descriptor={descriptor} state={field} t={t}
                      disabled={disabled}
                      onEdit={(text) => { props.edit(descriptor.field, text) }}
                      onReset={() => { props.resetField(descriptor.field) }} />
                  )
                })}
              </div>
            ))}
            <div className={css.footer}>
              {state.failed ? <p className={css.failed} role="status">{t('saveFailed')}</p> : null}
              <button type="button" className={css.discard} disabled={!state.dirty || state.saving}
                onClick={props.discard}>
                {t('discard')}
              </button>
              <button type="button" className={css.save}
                disabled={!state.dirty || state.invalid || state.saving || !state.writable}
                onClick={props.save}>
                {t(state.saving ? 'saving' : 'save')}
              </button>
            </div>
          </div>
        )
        : null}
    </li>
  )
}
