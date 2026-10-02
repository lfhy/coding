/**
 * 设置外壳包含侧栏触发器与独立的全屏设置页面。页面的返回控件和分区文案
 * 均来自 slot 注册项；引导步骤仍自行持有阻断式弹窗。
 */
import { useCallback, useEffect, useId, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import clsx from 'clsx'
import {
  IconAgentPresetOutline16, IconChevronLeftOutline14, IconDataOutline16,
  IconPersonalizationOutline16, IconSettingsOutline16, IconSparkle16,
} from '@deepseek-ai/dsh-client-ui-icons'
import type { SettingsRootComponentProps, SettingsSectionRow } from './shell-contract.ts'
import css from './SettingsRoot.module.css'

/** 按设置分区选择导航图标；其他分区使用设置图标。 */
function navIcon(id: string) {
  if (id === 'models') return <IconDataOutline16 className={css.navIcon} size={16} />
  if (id === 'vision-understanding') return <IconSparkle16 className={css.navIcon} size={16} />
  if (id === 'agent-presets') return <IconAgentPresetOutline16 className={css.navIcon} size={16} />
  if (id === 'plugins') return <IconPersonalizationOutline16 className={css.navIcon} size={16} />
  return <IconSettingsOutline16 className={css.navIcon} size={16} />
}

type PanelProps = {
  rows: readonly SettingsSectionRow[]
  renderSlot: SettingsRootComponentProps['renderSlot']
  activeId: string | undefined
  onSelect: (id: string) => void
  onClose: () => void
  trigger: HTMLButtonElement | null
}

/** 全屏设置页可由左上角返回按钮或 Escape 离开；内层弹窗自行处理 Escape。 */
function SettingsPanel({ rows, renderSlot, activeId, onSelect, onClose, trigger }: PanelProps) {
  const active = rows.find(r => r.id === activeId)?.id ?? rows[0]?.id
  const titleId = useId()
  const returnButton = useRef<HTMLButtonElement | null>(null)
  const pageRef = useRef<HTMLElement | null>(null)

  useEffect(() => {
    returnButton.current?.focus()
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return
      // 弹窗或展开的菜单先消费 Escape，不能同时离开设置页。
      if (document.querySelector('[role="dialog"][aria-modal="true"], [role="menu"], [role="listbox"]')) return
      onClose()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => { document.removeEventListener('keydown', onKeyDown) }
  }, [onClose])

  useEffect(() => {
    const page = pageRef.current
    if (page === null) return
    const siblings = Array.from(document.body.children).filter(
      (element): element is HTMLElement => element instanceof HTMLElement
        && element !== page
        && !element.querySelector('[role="dialog"][aria-modal="true"], [role="menu"], [role="listbox"]'),
    )
    const previous = siblings.map(element => ({ element, inert: element.inert }))
    siblings.forEach((element) => { element.inert = true })
    return () => {
      previous.forEach(({ element, inert }) => { element.inert = inert })
      if (trigger?.isConnected) trigger.focus()
    }
  }, [trigger])

  return (
    <main ref={pageRef} className={css.page} aria-labelledby={titleId}>
      <div className={clsx(css.panel, active === 'models' && css.modelsPanel)}>
        <nav className={css.nav}>
          <div className={css.navHeading}>
            <button ref={returnButton} type="button" className={css.back} onClick={onClose}>
              <IconChevronLeftOutline14 size={16} />
              <span className={css.hiddenLabel}>{renderSlot('settings.close', {})}</span>
            </button>
            <div className={css.navTitle} id={titleId}>{renderSlot('settings.header', {})}</div>
          </div>
          <div className={css.navList}>
            {rows.map(row => (
              <button
                key={row.id}
                type="button"
                className={clsx(css.navCell, row.id === active && css.active)}
                aria-current={row.id === active ? 'true' : undefined}
                onClick={() => { onSelect(row.id) }}
              >
                {navIcon(row.id)}
                <span className={css.navLabel}>{row.label}</span>
              </button>
            ))}
          </div>
        </nav>
        <div className={css.content}>
          <div className={css.header}>
            <div className={css.actions}>{renderSlot('settings.action', {})}</div>
          </div>
          <div className={css.options}>
            {active !== undefined && renderSlot('settings.section', { close: onClose }, { only: active })}
          </div>
        </div>
      </div>
    </main>
  )
}

/**
 * 渲染设置触发器、全屏分区页面和独立的引导步骤。
 * @param props - 由 slot 契约组合的组件属性。
 * @returns 设置外壳的元素树。
 */
export function SettingsRoot(props: SettingsRootComponentProps) {
  const { wide, useSections, useOnboardingSteps, useSessions, renderSlot } = props
  const [open, setOpen] = useState(false)
  const triggerRef = useRef<HTMLButtonElement | null>(null)
  const [activeId, setActiveId] = useState<string | undefined>(undefined)
  const [completedOnboarding, setCompletedOnboarding] = useState<ReadonlySet<string>>(() => new Set())
  const close = useCallback(() => {
    setOpen(false)
    setActiveId(undefined)
  }, [])
  const openSection = useCallback((id: string) => {
    setActiveId(id)
    setOpen(true)
  }, [])

  // 分区账本更新导航文案；触发器、标题和返回文案由各自 outlet 的订阅更新。
  const rows = useSections(s => s)
  const onboardingSteps = useOnboardingSteps(s => s)
  const onboardingActive = useSessions(state =>
    state.phase === 'ready'
    && (state.current === undefined || state.byId[state.current]?.blank === true))
  const onboardingStep = onboardingActive
    ? onboardingSteps.find(step => !completedOnboarding.has(step.id))
    : undefined

  useEffect(() => {
    if (onboardingActive) return
    setCompletedOnboarding(new Set())
  }, [onboardingActive])

  const completeOnboardingStep = useCallback((id: string) => {
    setCompletedOnboarding((previous) => {
      if (previous.has(id)) return previous
      return new Set([...previous, id])
    })
  }, [])

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className={clsx(css.trigger, !wide && css.rail)}
        aria-expanded={open}
        onClick={() => { setOpen(true) }}
      >
        {renderSlot('settings.trigger', { wide })}
      </button>
      {open && createPortal(
        <SettingsPanel
          rows={rows}
          renderSlot={renderSlot}
          activeId={activeId}
          onSelect={setActiveId}
          onClose={close}
          trigger={triggerRef.current}
        />,
        document.body,
      )}
      {/* 步骤的可见分支持有弹窗框架和 `#root` inert；私有事实判定期间不遮挡界面。 */}
      {onboardingStep !== undefined && renderSlot('settings.onboarding', {
        stepId: onboardingStep.id,
        complete: () => { completeOnboardingStep(onboardingStep.id) },
        openSection,
      }, { only: onboardingStep.id })}
    </>
  )
}
