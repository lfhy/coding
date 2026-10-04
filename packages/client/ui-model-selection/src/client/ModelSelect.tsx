/** 输入框模型入口：从会话目录选择渠道、模型及已公布的推理等级。 */
import {
  useEffect, useId, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore,
  type CSSProperties, type KeyboardEvent, type FocusEvent,
} from 'react'
import clsx from 'clsx'
import type { ModelSelection } from '@deepseek-ai/dsh-api-remotes/client'
import {
  IconCheckOutline16, IconChevronDownOutline14, IconChevronLeftOutline14,
  IconChevronRightOutline14, IconRefreshOutline16, IconSearchOutline16, IconWarningOutline16,
} from '@deepseek-ai/dsh-client-ui-icons'
import { Toast } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { ModelSelectInjected } from './slots.ts'
import css from './ModelSelect.module.css'

type Pane = 'effort' | 'models'

interface MenuPlacement {
  left: number
  width: number
}

function clipsHorizontally(element: HTMLElement): boolean {
  const style = getComputedStyle(element)
  const clipped = /^(auto|clip|hidden|scroll)$/
  return clipped.test(style.overflowX) || clipped.test(style.overflow)
}

/** 在所有横向裁切祖先与视口的交集内对齐触发器，保留菜单边缘的安全间距。 */
function measureMenuPlacement(root: HTMLElement, wide: boolean): MenuPlacement {
  const margin = 12
  let visibleLeft = margin
  let visibleRight = window.innerWidth - margin
  for (let ancestor = root.parentElement; ancestor !== null; ancestor = ancestor.parentElement) {
    if (!clipsHorizontally(ancestor)) continue
    const rect = ancestor.getBoundingClientRect()
    visibleLeft = Math.max(visibleLeft, rect.left + margin)
    visibleRight = Math.min(visibleRight, rect.right - margin)
  }
  const anchor = root.getBoundingClientRect()
  const width = Math.max(0, Math.min(wide ? 600 : 260, visibleRight - visibleLeft))
  const left = Math.max(visibleLeft, Math.min(anchor.right - width, visibleRight - width))
  return { left: left - anchor.left, width }
}

/**
 * 渲染输入框的模型入口。
 * @param props - 锁定状态、会话目录操作和当前语言的翻译函数。
 * @returns 触发器及打开时的推理强度或模型选择面板。
 */
export function ModelSelect(
  { locked, available, directory, load, select, t }:
  ModelSelectInjected & { locked: boolean } & PropsLocale<'model'>,
) {
  const state = useSyncExternalStore(
    fn => directory.subscribe(fn),
    () => directory.getSnapshot(),
  )
  const [open, setOpen] = useState(false)
  const [pane, setPane] = useState<Pane>('effort')
  const [providerId, setProviderId] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [draftIndex, setDraftIndex] = useState<number | null>(null)
  // 选择失败通过 Toast 提示，目录加载失败才在菜单内保留重试入口。
  const lastActionRef = useRef<'load' | 'select'>('load')
  const [toast, setToast] = useState<{ seq: number; text: string } | null>(null)
  const toastSeq = useRef(0)
  const rootRef = useRef<HTMLDivElement | null>(null)
  const [menuPlacement, setMenuPlacement] = useState<MenuPlacement | null>(null)
  const triggerRef = useRef<HTMLButtonElement | null>(null)
  const searchRef = useRef<HTMLInputElement | null>(null)
  const effortControlRef = useRef<HTMLInputElement | HTMLButtonElement | null>(null)
  const restoreEffortFocusRef = useRef(false)
  const id = useId()

  const choices = useMemo(() => state.groups.flatMap(group =>
    group.models.map(model => ({
      group,
      model,
      selection: {
        provider: group.id,
        model: model.id,
        ...model.reasoning?.defaultEffort === undefined
          ? {}
          : { reasoningEffort: model.reasoning.defaultEffort },
      } satisfies ModelSelection,
    }))), [state.groups])
  const selectedIndex = state.current === null
    ? -1
    : choices.findIndex(c => c.selection.provider === state.current?.provider && c.selection.model === state.current.model)
  const currentChoice = choices[selectedIndex]
  const provider = state.groups.find(group => group.id === providerId)
  const reasoning = currentChoice?.model.reasoning
  const effectiveEffort = state.current?.reasoningEffort ?? reasoning?.defaultEffort
  const effortLabel = reasoning === undefined
    ? undefined
    : effectiveEffort === undefined
      ? t('effort.providerDefault')
      : effectiveEffort === 'off'
        ? t('effort.none')
        : reasoning.efforts.find(level => level.id === effectiveEffort)?.name ?? effectiveEffort
  const effortStops = useMemo(() => reasoning === undefined
    ? []
    : [
      ...reasoning.defaultEffort === undefined
        ? [{ effort: undefined, label: t('effort.providerDefault'), description: undefined }]
        : [],
      ...reasoning.efforts.map(level => ({
        effort: level.id,
        label: level.id === 'off' ? t('effort.none') : level.name,
        description: level.description,
      })),
    ], [reasoning, t])
  const effortIndex = effortStops.findIndex(level => level.effort === effectiveEffort)
  const activeEffort = draftIndex === null
    ? effortStops[effortIndex]
    : effortStops[draftIndex]
  const activeEffortId = activeEffort?.effort?.toLowerCase()
  const activeEffortName = activeEffort?.label.toLowerCase()
  const effortTone = activeEffortName === 'ultra' || activeEffortId === 'ultra' || activeEffortId === 'xhigh'
    ? css.toneUltra
    : activeEffortId === 'max' ? css.toneMax
      : activeEffortId === 'high' || activeEffortId === 'medium' ? css.toneHigh
        : activeEffortId === 'low' || activeEffortId === 'minimal' ? css.toneLow
          : css.toneNeutral
  const previewIndex = draftIndex ?? Math.max(0, effortIndex)
  const sliderStyle = { '--reasoning-position': effortStops.length > 1
    ? previewIndex / (effortStops.length - 1) : 0 } as CSSProperties
  const hasEffortPanel = new Set(effortStops.map(level => level.effort)).size > 1
    || (effortStops.length > 0 && effortIndex < 0)
  const normalizedQuery = query.trim().toLocaleLowerCase()
  const filteredModels = provider?.models.filter(model =>
    model.name.toLocaleLowerCase().includes(normalizedQuery)
    || model.id.toLocaleLowerCase().includes(normalizedQuery),
  ) ?? []
  const busy = state.status === 'selecting'

  const reload = (): void => {
    lastActionRef.current = 'load'
    load()
  }

  // 初次加载用于触发器回显；每次展开都会刷新目录。
  useEffect(() => {
    if (available) {
      lastActionRef.current = 'load'
      load()
    }
  }, [available, load])

  useEffect(() => {
    if (!open) return
    const closeOutside = (event: MouseEvent): void => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', closeOutside)
    return () => { document.removeEventListener('mousedown', closeOutside) }
  }, [open])

  useLayoutEffect(() => {
    if (!open || rootRef.current === null) return
    const root = rootRef.current
    const place = (): void => {
      const next = measureMenuPlacement(root, pane === 'models')
      setMenuPlacement(previous => previous?.left === next.left && previous.width === next.width ? previous : next)
    }
    place()
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(place)
    observer?.observe(root)
    for (let ancestor = root.parentElement; ancestor !== null; ancestor = ancestor.parentElement) {
      if (clipsHorizontally(ancestor)) observer?.observe(ancestor)
    }
    window.addEventListener('resize', place)
    window.addEventListener('scroll', place, true)
    return () => {
      observer?.disconnect()
      window.removeEventListener('resize', place)
      window.removeEventListener('scroll', place, true)
    }
  }, [open, pane])

  useEffect(() => {
    if (!open || pane !== 'models' || provider !== undefined || state.groups.length === 0) return
    setProviderId(currentChoice?.group.id ?? state.groups[0]?.id ?? null)
  }, [open, pane, provider, currentChoice, state.groups])

  useEffect(() => {
    if (open && pane === 'effort' && !hasEffortPanel) setPane('models')
  }, [open, pane, hasEffortPanel])

  useEffect(() => {
    if (!open) return
    if (pane === 'models') {
      searchRef.current?.focus()
    } else if (!busy && restoreEffortFocusRef.current) {
      restoreEffortFocusRef.current = false
      effortControlRef.current?.focus()
    }
  }, [open, pane, busy, draftIndex])

  if (!available) return null

  const show = (): void => {
    setPane(hasEffortPanel ? 'effort' : 'models')
    setProviderId(currentChoice?.group.id ?? state.groups[0]?.id ?? null)
    setQuery('')
    setDraftIndex(null)
    restoreEffortFocusRef.current = false
    setOpen(true)
    reload()
  }

  const close = (restoreFocus = false): void => {
    setOpen(false)
    setPane('effort')
    setProviderId(null)
    restoreEffortFocusRef.current = false
    if (restoreFocus) queueMicrotask(() => { triggerRef.current?.focus() })
  }

  const onRootKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === 'Escape' && open) {
      event.preventDefault()
      if (pane === 'models' && hasEffortPanel) {
        restoreEffortFocusRef.current = true
        setPane('effort')
      }
      else close(true)
      return
    }
    if (!open || pane !== 'models' || event.target instanceof HTMLInputElement) return
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      const items = Array.from(rootRef.current?.querySelectorAll<HTMLButtonElement>('[data-model-option]') ?? [])
      if (items.length === 0 || !items.includes(document.activeElement as HTMLButtonElement)) return
      event.preventDefault()
      const active = items.indexOf(document.activeElement as HTMLButtonElement)
      items[(active + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length]?.focus()
    }
  }

  const onBlur = (event: FocusEvent<HTMLDivElement>): void => {
    if (event.relatedTarget instanceof Node && rootRef.current?.contains(event.relatedTarget)) return
    close()
  }

  const settleSelection = (accepted: boolean, keepOpen = false): void => {
    if (accepted) {
      if (!keepOpen && rootRef.current !== null) close(true)
      return
    }
    const message = directory.getSnapshot().error
    if (message !== null) {
      toastSeq.current += 1
      setToast({ seq: toastSeq.current, text: t('error.action', { message }) })
    }
  }

  const choose = (selection: ModelSelection): void => {
    if (state.current?.provider === selection.provider && state.current.model === selection.model) {
      close(true)
      return
    }
    lastActionRef.current = 'select'
    void select(selection).then((accepted) => { settleSelection(accepted) })
  }

  const chooseEffort = (effort: string | undefined): void => {
    if (busy || state.current === null) return
    if (state.current.reasoningEffort === effort) {
      setDraftIndex(null)
      return
    }
    const selection: ModelSelection = {
      provider: state.current.provider,
      model: state.current.model,
      ...effort === undefined ? {} : { reasoningEffort: effort },
    }
    lastActionRef.current = 'select'
    void select(selection).then((accepted) => {
      setDraftIndex(null)
      settleSelection(accepted, true)
    })
  }

  const commitEffort = (index: number): void => {
    const level = effortStops[index]
    if (level !== undefined) {
      restoreEffortFocusRef.current = true
      setDraftIndex(index)
      chooseEffort(level.effort)
    }
  }

  const modelLabel = currentChoice?.model.name ?? t('trigger.fallback')
  const triggerLabel = effortLabel === undefined ? modelLabel : `${modelLabel} · ${effortLabel}`
  const visibleTriggerLabel = open ? t('trigger.strength') : modelLabel
  const triggerAria = currentChoice === undefined
    ? t('trigger.selectAria')
    : effortLabel === undefined
      ? t('trigger.aria', { model: modelLabel })
      : t('trigger.ariaEffort', { model: modelLabel, effort: effortLabel })
  return (
    <div ref={rootRef} className={css.root} onKeyDown={onRootKeyDown} onBlur={onBlur}>
      <button
        ref={triggerRef}
        type="button"
        className={clsx(css.trigger, open && css.triggerOpen)}
        aria-label={triggerAria}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? `${id}-menu` : undefined}
        title={triggerLabel}
        disabled={locked}
        onClick={() => {
          if (open) {
            close()
          } else {
            show()
          }
        }}
      >
        <span className={css.triggerLabel}>{visibleTriggerLabel}</span>
        {!open && effortLabel !== undefined && <span className={css.triggerEffort}>{effortLabel}</span>}
        <IconChevronDownOutline14 className={clsx(css.chevron, open && css.chevronOpen)} />
      </button>

      {open && (
        <div
          id={`${id}-menu`}
          className={clsx(css.menu, pane === 'models' ? css.wideMenu : css.effortMenu, pane === 'effort' && effortTone)}
          style={menuPlacement === null ? undefined : { left: menuPlacement.left, width: menuPlacement.width }}
          role="dialog"
          aria-modal="false"
          aria-label={pane === 'models' ? t('models.aria') : t('effort.aria')}
          aria-busy={state.status === 'loading' || busy}
        >
          {pane === 'effort' && (
            <>
              <div className={css.effortHeader}>
                <strong className={css.currentEffort}>{activeEffort?.label ?? effortLabel ?? t('empty.efforts')}</strong>
                {reasoning !== undefined && (
                  <button
                    type="button"
                    className={css.reset}
                    aria-label={t('effort.reset')}
                    title={t('effort.reset')}
                    disabled={busy || (state.current?.reasoningEffort ?? reasoning.defaultEffort) === reasoning.defaultEffort}
                    onClick={() => { chooseEffort(undefined) }}
                  ><IconRefreshOutline16 /></button>
                )}
                <button
                  type="button"
                  className={css.modelLink}
                  aria-label={t('models.currentAria', { model: modelLabel })}
                  onClick={() => { setPane('models') }}
                >
                  <span className={css.modelName}>{modelLabel}</span>
                  <IconChevronRightOutline14 className={css.cellChevron} />
                </button>
              </div>
              <div className={css.compactMessages}>
                {state.status === 'loading' && state.groups.length === 0
                  && <div role="status" className={css.status}>{t('status.loading')}</div>}
                {state.error !== null && lastActionRef.current === 'load' && (
                  <div role="alert" className={css.error}>
                    <span>{t('error.action', { message: state.error })}</span>
                    <button type="button" className={css.retry} onClick={reload}>{t('action.reload')}</button>
                  </div>
                )}
                {state.failures.map(failure => (
                  <div className={css.warning} key={failure.id}>
                    <span>{t('warning.groupLoad', { name: failure.name, message: failure.message })}</span>
                    <button type="button" className={css.retry} onClick={reload}>{t('action.reload')}</button>
                  </div>
                ))}
              </div>
              {effortStops.length > 1 && (
                <div className={css.sliderGroup}>
                  <label htmlFor={`${id}-effort`} className={css.visuallyHidden}>{t('effort.adjust')}</label>
                  <div
                    className={clsx(css.sliderRail, effortIndex < 0 && draftIndex === null && css.sliderUnspecified)}
                    style={sliderStyle}
                  >
                    <span className={css.sliderFill} aria-hidden="true" />
                    <span className={css.railDots} aria-hidden="true">
                      {effortStops.map(level => <span key={level.effort ?? 'default'} />)}
                    </span>
                    <input
                      ref={(node) => { effortControlRef.current = node }}
                      id={`${id}-effort`}
                      className={css.slider}
                      type="range"
                      min={0}
                      max={effortStops.length - 1}
                      step={1}
                      value={draftIndex ?? Math.max(0, effortIndex)}
                      aria-valuetext={activeEffort?.label ?? effortLabel}
                      aria-describedby={activeEffort?.description === undefined ? undefined : `${id}-effort-description`}
                      disabled={busy}
                      onChange={(event) => { setDraftIndex(Number(event.currentTarget.value)) }}
                      onPointerUp={(event) => { commitEffort(Number(event.currentTarget.value)) }}
                      onPointerCancel={() => { setDraftIndex(null) }}
                      onKeyUp={(event) => {
                        if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown'].includes(event.key)) {
                          commitEffort(Number(event.currentTarget.value))
                        }
                      }}
                      onBlur={(event) => {
                        if (draftIndex !== null) commitEffort(Number(event.currentTarget.value))
                      }}
                    />
                  </div>
                  {activeEffort?.description !== undefined && (
                    <div id={`${id}-effort-description`} className={css.visuallyHidden}>{activeEffort.description}</div>
                  )}
                </div>
              )}
              {effortStops.length === 1 && effortStops[0] !== undefined && (
                <button
                  ref={(node) => { effortControlRef.current = node }}
                  type="button"
                  className={css.singleEffort}
                  aria-describedby={effortStops[0].description === undefined ? undefined : `${id}-effort-description`}
                  disabled={busy || effectiveEffort === effortStops[0].effort}
                  onClick={() => { chooseEffort(effortStops[0]?.effort) }}
                >{effortStops[0].label}</button>
              )}
              {effortStops.length === 1 && effortStops[0]?.description !== undefined && (
                <div id={`${id}-effort-description`} className={css.visuallyHidden}>{effortStops[0].description}</div>
              )}
            </>
          )}
          {pane === 'models' && (
            <div className={css.browser}>
              <div className={clsx(css.providers, 'scrollable')} role="group" aria-label={t('providers.aria')}>
                <div className={css.eyebrow}>{t('providers.title')}</div>
                {state.groups.map((group) => {
                  const active = providerId === group.id
                  return (
                    <button
                      key={group.id}
                      type="button"
                      className={clsx(css.provider, active && css.providerSelected)}
                      aria-pressed={active}
                      title={group.name}
                      onClick={() => { setProviderId(group.id); setQuery('') }}
                    >
                      <span className={css.providerCheck}>{state.current?.provider === group.id && <IconCheckOutline16 />}</span>
                      <span className={css.providerName}>{group.name}</span>
                    </button>
                  )
                })}
              </div>
              <div className={css.modelsPane}>
                <div className={css.modelsHeader}>
                  <span className={css.providerName}>{provider?.name ?? t('models.title')}</span>
                  {hasEffortPanel && (
                    <button type="button" className={css.back} onClick={() => {
                      restoreEffortFocusRef.current = true
                      setPane('effort')
                    }}>
                      <IconChevronLeftOutline14 />{t('models.back')}
                    </button>
                  )}
                </div>
                <label className={css.searchBox}>
                  <IconSearchOutline16 />
                  <span className={css.visuallyHidden}>{t('models.search')}</span>
                  <input
                    ref={searchRef}
                    type="search"
                    value={query}
                    placeholder={t('models.search')}
                    onChange={(event) => { setQuery(event.currentTarget.value) }}
                  />
                </label>
                {state.status === 'loading' && <div role="status" className={css.status}>{t('status.loading')}</div>}
                {state.error !== null && lastActionRef.current === 'load' && (
                  <div role="alert" className={css.error}>
                    <span>{t('error.action', { message: state.error })}</span>
                    <button type="button" className={css.retry} onClick={reload}>{t('action.reload')}</button>
                  </div>
                )}
                {state.failures.map(failure => (
                  <div className={css.warning} key={failure.id}>
                    <span>{t('warning.groupLoad', { name: failure.name, message: failure.message })}</span>
                    <button type="button" className={css.retry} onClick={reload}>{t('action.reload')}</button>
                  </div>
                ))}
                <div className={clsx(css.groups, 'scrollable')}>
                  {filteredModels.map((model) => {
                    if (provider === undefined) return null
                    const selected = state.current?.provider === provider.id && state.current.model === model.id
                    return (
                      <button
                        data-model-option
                        type="button"
                        aria-current={selected ? 'true' : undefined}
                        className={clsx(css.option, selected && css.selected)}
                        key={model.id}
                        title={model.name}
                        disabled={busy}
                        onClick={() => { choose({
                          provider: provider.id,
                          model: model.id,
                          ...model.reasoning?.defaultEffort === undefined ? {} : { reasoningEffort: model.reasoning.defaultEffort },
                        }) }}
                      >
                        <span className={css.optionCopy}>
                          <span className={css.modelName}>{model.name}</span>
                          {model.description !== undefined && (
                            <span className={css.description}>{model.description}</span>
                          )}
                        </span>
                        <span className={css.check}>
                          {selected ? <IconCheckOutline16 /> : null}
                        </span>
                      </button>
                    )
                  })}
                </div>
                {filteredModels.length === 0 && <div className={css.empty}>{query ? t('empty.search') : t('empty.models')}</div>}
              </div>
            </div>
          )}
        </div>
      )}
      {toast !== null && (
        <Toast
          key={toast.seq}
          text={toast.text}
          icon={<IconWarningOutline16 />}
          anchor={rootRef.current?.closest<HTMLElement>('[data-composer-card]') ?? null}
          onDone={() => { setToast(null) }}
        />
      )}
    </div>
  )
}
