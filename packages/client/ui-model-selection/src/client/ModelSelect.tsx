/** 输入框模型入口：从会话目录选择渠道、模型及已公布的推理等级。 */
import {
  useEffect, useId, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore,
  type KeyboardEvent, type FocusEvent,
} from 'react'
import clsx from 'clsx'
import type { ModelReasoningEffort, ModelSelection } from '@deepseek-ai/dsh-api-remotes/client'
import {
  IconCheckOutline16, IconChevronDownOutline14, IconChevronLeftOutline14,
  IconChevronRightOutline14, IconWarningOutline16,
} from '@deepseek-ai/dsh-client-ui-icons'
import { Toast } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { ModelSelectInjected } from './slots.ts'
import css from './ModelSelect.module.css'

type Pane = 'providers' | 'models' | 'effort'

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
function measureMenuPlacement(root: HTMLElement): MenuPlacement {
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
  const width = Math.max(0, Math.min(260, visibleRight - visibleLeft))
  const left = Math.max(visibleLeft, Math.min(anchor.right - width, visibleRight - width))
  return { left: left - anchor.left, width }
}

/** undefined 表示沿用提供方的默认推理等级。 */
interface EffortChoice {
  key: string
  effort: string | undefined
  label: string
  description?: string
}

/**
 * 渲染输入框的模型入口。
 * @param props - 锁定状态、会话目录操作和当前语言的翻译函数。
 * @returns 触发器及打开时的渠道、模型或推理等级菜单。
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
  const [pane, setPane] = useState<Pane>('providers')
  const [providerId, setProviderId] = useState<string | null>(null)
  // 选择失败通过 Toast 提示，目录加载失败才在菜单内保留重试入口。
  const lastActionRef = useRef<'load' | 'select'>('load')
  const [toast, setToast] = useState<{ seq: number; text: string } | null>(null)
  const toastSeq = useRef(0)
  const rootRef = useRef<HTMLDivElement | null>(null)
  const [menuPlacement, setMenuPlacement] = useState<MenuPlacement | null>(null)
  const triggerRef = useRef<HTMLButtonElement | null>(null)
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([])
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
  // 仅在渠道没有声明默认档位时显示默认选项，避免重复列出同一个推理等级。
  const effortChoices = useMemo<readonly EffortChoice[]>(() => reasoning === undefined
    ? []
    : [
      ...reasoning.defaultEffort === undefined
        ? [{ key: 'provider-default', effort: undefined, label: t('effort.providerDefault') }]
        : [],
      ...reasoning.efforts.map((effort: ModelReasoningEffort) => ({
        key: `effort:${effort.id}`,
        effort: effort.id,
        label: effort.id === 'off' ? t('effort.none') : effort.name,
        ...effort.description === undefined ? {} : { description: effort.description },
      })),
    ], [reasoning, t])
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
      const next = measureMenuPlacement(root)
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
  }, [open])

  useEffect(() => {
    if (!open || pane === 'providers' || provider !== undefined) return
    setPane('providers')
    setProviderId(null)
  }, [open, pane, provider])

  useEffect(() => {
    if (open) itemRefs.current.find(item => item !== null)?.focus()
  }, [open, pane])

  if (!available) return null

  const show = (): void => {
    setPane('providers')
    setProviderId(null)
    setOpen(true)
    reload()
  }

  const close = (restoreFocus = false): void => {
    setOpen(false)
    setPane('providers')
    setProviderId(null)
    if (restoreFocus) queueMicrotask(() => { triggerRef.current?.focus() })
  }

  const moveFocus = (offset: number): void => {
    const items = itemRefs.current.filter(item => item !== null)
    if (items.length === 0) return
    const active = items.findIndex(item => item === document.activeElement)
    const next = (Math.max(active, 0) + offset + items.length) % items.length
    items[next]?.focus()
  }

  const onRootKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === 'Escape' && open) {
      event.preventDefault()
      if (pane === 'effort') setPane('models')
      else if (pane === 'models') { setPane('providers'); setProviderId(null) }
      else close(true)
      return
    }
    if (!open) return
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      moveFocus(event.key === 'ArrowDown' ? 1 : -1)
    }
  }

  const onBlur = (event: FocusEvent<HTMLDivElement>): void => {
    if (event.relatedTarget instanceof Node && rootRef.current?.contains(event.relatedTarget)) return
    close()
  }

  const settleSelection = (accepted: boolean): void => {
    if (accepted) {
      if (rootRef.current !== null) close(true)
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
    void select(selection).then(settleSelection)
  }

  const chooseEffort = (effort: string | undefined): void => {
    if (state.current === null) return
    if (effectiveEffort === effort) {
      close(true)
      return
    }
    const selection: ModelSelection = {
      provider: state.current.provider,
      model: state.current.model,
      ...effort === undefined ? {} : { reasoningEffort: effort },
    }
    lastActionRef.current = 'select'
    void select(selection).then(settleSelection)
  }

  const modelLabel = currentChoice?.model.name ?? t('trigger.fallback')
  const triggerLabel = effortLabel === undefined ? modelLabel : `${modelLabel} · ${effortLabel}`
  const triggerAria = currentChoice === undefined
    ? t('trigger.selectAria')
    : effortLabel === undefined
      ? t('trigger.aria', { model: modelLabel })
      : t('trigger.ariaEffort', { model: modelLabel, effort: effortLabel })
  itemRefs.current = []
  let itemIndex = 0
  const itemRef = () => {
    const at = itemIndex++
    return (node: HTMLButtonElement | null) => { itemRefs.current[at] = node }
  }

  return (
    <div ref={rootRef} className={css.root} onKeyDown={onRootKeyDown} onBlur={onBlur}>
      <button
        ref={triggerRef}
        type="button"
        className={css.trigger}
        aria-label={triggerAria}
        aria-haspopup="menu"
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
        <span className={css.triggerLabel}>{modelLabel}</span>
        {effortLabel !== undefined && <span className={css.triggerEffort}>{effortLabel}</span>}
        <IconChevronDownOutline14 className={clsx(css.chevron, open && css.chevronOpen)} />
      </button>

      {open && (
        <div
          id={`${id}-menu`}
          className={css.menu}
          style={menuPlacement === null ? undefined : { left: menuPlacement.left, right: 'auto', width: menuPlacement.width }}
          role="menu"
          aria-label={t('menu.aria')}
          aria-busy={state.status === 'loading' || busy}
        >
          {pane === 'providers' && (
            <>
              {state.status === 'loading' && <div role="status" className={css.status}>{t('status.loading')}</div>}
              {state.error !== null && lastActionRef.current === 'load' && (
                <div role="alert" className={css.error}>
                  <span>{t('error.action', { message: state.error })}</span>
                  <button type="button" className={css.retry} onClick={reload}>{t('retry')}</button>
                </div>
              )}
              {state.failures.map(failure => (
                <div className={css.warning} key={failure.id}>
                  <span>{t('warning.groupLoad', { name: failure.name, message: failure.message })}</span>
                  <button type="button" className={css.retry} onClick={reload}>{t('retry')}</button>
                </div>
              ))}
              <div className={clsx(css.groups, 'scrollable')}>
                {state.groups.map((group) => {
                  const selected = state.current?.provider === group.id
                  return (
                    <button
                      ref={itemRef()}
                      type="button"
                      role="menuitem"
                      aria-current={selected ? 'true' : undefined}
                      aria-haspopup="menu"
                      className={clsx(css.provider, selected && css.providerSelected)}
                      key={group.id}
                      title={group.name}
                      onClick={() => { setProviderId(group.id); setPane('models') }}
                    >
                      <span className={css.providerCheck}>{selected && <IconCheckOutline16 />}</span>
                      <span className={css.providerName}>{group.name}</span>
                      <IconChevronRightOutline14 className={css.cellChevron} />
                    </button>
                  )
                })}
              </div>
              {state.status === 'ready' && state.groups.length === 0 && (
                <div className={css.empty}>{t('empty.models')}</div>
              )}
            </>
          )}

          {pane === 'models' && provider !== undefined && (
            <>
              <button ref={itemRef()} type="button" role="menuitem" className={css.back} onClick={() => { setPane('providers'); setProviderId(null) }}>
                <IconChevronLeftOutline14 />
                <span className={css.providerName}>{provider.name}</span>
              </button>
              <div className={clsx(css.groups, 'scrollable')}>
                {provider.models.map((model) => {
                  const selected = state.current?.provider === provider.id && state.current.model === model.id
                  return (
                    <button
                      ref={itemRef()}
                      type="button"
                      role="menuitemradio"
                      aria-checked={selected}
                      className={clsx(css.option, selected && css.selected)}
                      key={model.id}
                      title={model.name}
                      disabled={busy}
                      onClick={() => { choose({ provider: provider.id, model: model.id }) }}
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
              {provider.models.length === 0 && (
                <div className={css.empty}>{t('empty.models')}</div>
              )}
              {reasoning !== undefined && state.current?.provider === provider.id && (
                <button ref={itemRef()} type="button" role="menuitem" className={css.cell} onClick={() => { setPane('effort') }}>
                  <span className={css.cellLabel}>{t('menu.effort')}</span>
                  <span className={css.cellValue}>{effortLabel}</span>
                  <IconChevronRightOutline14 className={css.cellChevron} />
                </button>
              )}
            </>
          )}

          {pane === 'effort' && provider !== undefined && (
            <>
              <button ref={itemRef()} type="button" role="menuitem" className={css.back} onClick={() => { setPane('models') }}>
                <IconChevronLeftOutline14 />
                <span>{t('menu.effort')}</span>
              </button>
              {state.error !== null && lastActionRef.current === 'load' && (
                <div className={css.error}>
                  <span>{t('error.action', { message: state.error })}</span>
                  <button type="button" className={css.retry} onClick={reload}>{t('action.reload')}</button>
                </div>
              )}
              {effortChoices.length === 0
                ? <div className={css.empty}>{t('empty.efforts')}</div>
                : effortChoices.map(level => (
                  <button
                    ref={itemRef()}
                    type="button"
                    role="menuitemradio"
                    aria-checked={effectiveEffort === level.effort}
                    className={clsx(css.option, effectiveEffort === level.effort && css.selected)}
                    key={level.key}
                    disabled={busy}
                    onClick={() => { chooseEffort(level.effort) }}
                  >
                    <span className={css.optionCopy}>
                      <span className={css.modelName}>{level.label}</span>
                      {level.description !== undefined && (
                        <span className={css.description}>{level.description}</span>
                      )}
                    </span>
                    <span className={css.check}>
                      {effectiveEffort === level.effort ? <IconCheckOutline16 /> : null}
                    </span>
                  </button>
                ))}
            </>
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
