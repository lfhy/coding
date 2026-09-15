/**
 * 权限偏好行：设置后续新建会话的默认预设。当前会话仍由输入区的 `/permission`
 * 控件切换。
 */

import { useEffect, useState } from 'react'
import type { SnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import {
  IconChevronDownOutline14, Menu, RiskConfirmation,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { PermissionSettingsState } from './settings-store.ts'
import type { PermissionSettingsKey } from './locales.ts'
import { displayPermissionPreset, FULL_ACCESS_PRESET } from './presentation.ts'
import css from './PermissionRow.module.css'

/** 注册侧提供的 host 持久偏好业务接口。 */
export interface PermissionRowInjected {
  hooks: {
    /** 由渲染器绑定为 usePermission 的权限设置快照。 */
    permission: SnapshotStore<PermissionSettingsState>
  }
  /** 首次渲染该行时加载描述符。 */
  load: () => Promise<void>
  /** 持久化一个已公开预设。 */
  select: (preset: string) => Promise<void>
}

/** 完整组件 props。 */
export type PermissionRowProps =
  PropsRuntime<'settings.general.item'>
  & PropsLocale<'settings.permission'>
  & InjectFace<PermissionRowInjected>

/**
 * 渲染新会话的权限默认值选择器。
 * @param props - 组合后的 slot props。
 * @returns 设置行；host 未公开权限设置时返回 null。
 */
export function PermissionRow({ load, select, usePermission, t }: PermissionRowProps) {
  const state = usePermission(snapshot => snapshot)
  const [open, setOpen] = useState(false)
  const [confirmingFullAccess, setConfirmingFullAccess] = useState(false)
  const [acknowledged, setAcknowledged] = useState(false)

  useEffect(() => {
    void load()
  }, [load])

  useEffect(() => {
    if (state.writable && state.status !== 'unavailable') return
    setOpen(false)
    setAcknowledged(false)
    setConfirmingFullAccess(false)
  }, [state.status, state.writable])

  if (state.status === 'unavailable') return null
  const selected = state.options.find(option => option.id === state.currentValue)
  const busy = state.status === 'loading' || state.status === 'saving' || confirmingFullAccess
  const label = selected === undefined
    ? (busy ? t('loading') : t('unavailable'))
    : displayPermissionPreset(selected.id, selected.label, t)
  const description: string = state.error ?? t('description')

  return (
    <>
      <div className={css.row}>
        <div className={css.rowText}>
          <div className={css.title}>{t('title')}</div>
          <div className={css.desc} role={state.error === null ? undefined : 'alert'}>{description}</div>
        </div>
        <Menu
          open={open}
          onClose={() => { setOpen(false) }}
          items={state.options.map(option => ({
            id: option.id,
            label: displayPermissionPreset(option.id, option.label, t),
          }))}
          selectedId={state.currentValue}
          onSelect={(id) => {
            setOpen(false)
            if (id === state.currentValue) return
            if (id === FULL_ACCESS_PRESET) {
              setAcknowledged(false)
              setConfirmingFullAccess(true)
              return
            }
            void select(id)
          }}
          align="end"
          portal
          anchor={(
            <button
              type="button"
              className={css.selector}
              aria-haspopup="menu"
              aria-expanded={open}
              disabled={busy || !state.writable || state.options.length === 0}
              onClick={() => { setOpen(value => !value) }}
            >
              {label}
              <IconChevronDownOutline14 className={css.chevron} />
            </button>
          )}
        />
      </div>
      <RiskConfirmation
        open={confirmingFullAccess}
        title={t('confirm.title')}
        description={t('confirm.description')}
        acknowledgeLabel={t('confirm.acknowledge')}
        closeLabel={t('confirm.close')}
        cancelLabel={t('confirm.cancel')}
        confirmLabel={t('confirm.enable')}
        acknowledged={acknowledged}
        disabled={!state.writable || state.status === 'saving'}
        onAcknowledgedChange={setAcknowledged}
        onCancel={() => {
          setAcknowledged(false)
          setConfirmingFullAccess(false)
        }}
        onConfirm={() => {
          setAcknowledged(false)
          setConfirmingFullAccess(false)
          void select(FULL_ACCESS_PRESET)
        }}
      />
    </>
  )
}

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Permission row copy. */
    'settings.permission': PermissionSettingsKey
  }
}
