/**
 * 侧边栏品牌行里的常驻工作台面板开关：文件侧栏与终端底栏。它们在工作台之外
 * 渲染，因此工作台关闭（还原态）或最大化隐藏整个会话页头时依然可达；点击时
 * 若工作台未打开，布局服务会先打开工作台再显示对应面板——文件侧栏默认呈现
 * 内置文件管理，终端底栏默认呈现终端。没有当前会话时不渲染；空白会话
 * 仍有真实 Session 与工作目录，可直接打开终端。
 */
import { useCallback, useMemo, useState, useSyncExternalStore } from 'react'
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-runtime/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { WorkbenchLayoutSnapshot } from '@deepseek-ai/dsh-client-ui-layout/client'
import { Icon, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { NS } from './locales.ts'
import css from './WorkbenchPanelToggles.module.css'

/** 侧边栏品牌行注入的工作台状态源与两个面板开关动作。 */
export interface WorkbenchPanelTogglesInjected {
  /**
   * 返回指定 Session 的工作台可见状态源；尚未发布状态的 Session 按关闭态。
   * @param sessionId - 要读取的会话。
   * @returns AppFrame 投影的工作台显隐快照源。
   */
  workbenchSource: (sessionId: SessionId) => ObservableSnapshot<WorkbenchLayoutSnapshot>
  /** 切换当前 Session 的文件侧栏；工作台未打开时先打开工作台。 */
  toggleFiles: () => void
  /** 切换当前 Session 的终端底栏；工作台未打开时先打开工作台。 */
  toggleBottom: () => void
}

/** 品牌行开关的 slot props：owner share、注入面与词典。 */
export type WorkbenchPanelTogglesProps =
  & PropsRuntime<'sidebar.brand.action'>
  & InjectFace<WorkbenchPanelTogglesInjected>
  & PropsLocale<typeof NS>

/** 无当前会话时的固定关闭态，保证 uSES 的 getSnapshot 身份稳定。 */
const CLOSED_WORKBENCH: WorkbenchLayoutSnapshot = {
  open: false,
  fullscreen: false,
  bottomOpen: false,
  filesOpen: false,
}

/**
 * 订阅一个可能缺席的工作台状态源。
 * @param source - 当前会话的状态源；没有当前会话时为 undefined。
 * @returns 最新的工作台显隐快照；无源时固定为关闭态。
 */
function useWorkbenchLayout(
  source: ObservableSnapshot<WorkbenchLayoutSnapshot> | undefined,
): WorkbenchLayoutSnapshot {
  const subscribe = useCallback(
    (listener: () => void) => source?.subscribe(listener) ?? (() => {}),
    [source],
  )
  const getSnapshot = useCallback(() => source?.getSnapshot() ?? CLOSED_WORKBENCH, [source])
  return useSyncExternalStore(subscribe, getSnapshot)
}

/** 欢迎页底栏按钮的状态源与打开动作。 */
export interface HeroBottomToggleInjected {
  workbenchSource: WorkbenchPanelTogglesInjected['workbenchSource']
  toggleBottom: () => Promise<void>
}

/**
 * 欢迎页右上角的底栏入口；尚无 Session 时会先创建可用的空白会话。
 * @param props - 当前会话、工作台状态源、打开动作与本地化文案。
 * @returns 带按下状态和失败反馈的底栏图标按钮。
 */
export function HeroBottomToggle({ useSessions, workbenchSource, toggleBottom, t }:
  PropsRuntime<'conversation.hero.actions'> & InjectFace<HeroBottomToggleInjected> & PropsLocale<typeof NS>) {
  const sessionId = useSessions(state => state.current)
  const source = useMemo(
    () => sessionId === undefined ? undefined : workbenchSource(sessionId),
    [sessionId, workbenchSource],
  )
  const workbench = useWorkbenchLayout(source)
  const pressed = workbench.open && workbench.bottomOpen
  const [opening, setOpening] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const label = t(opening ? 'workbench.bottom.opening' : pressed ? 'workbench.bottom.close' : 'workbench.bottom.open')
  return (
    <>
      <Tooltip label={label} delayMs={500}>
        <button
          type="button"
          className={css.button}
          title={label}
          aria-label={label}
          aria-pressed={pressed}
          disabled={opening}
          onClick={() => {
            setOpening(true)
            setError(null)
            void toggleBottom().catch((reason: unknown) => {
              setError(t('workbench.bottom.failed', {
                message: reason instanceof Error ? reason.message : String(reason),
              }))
            }).finally(() => { setOpening(false) })
          }}
        >
          <Icon name="bottom-panel" size={18} />
        </button>
      </Tooltip>
      {error !== null && <span className={css.heroError} role="alert">{error}</span>}
    </>
  )
}

/** 单个面板开关按钮；按下态表达面板当前实际可见。 */
function PanelButton({ label, pressed, onClick, icon }: {
  label: string
  pressed: boolean
  onClick: () => void
  icon: React.JSX.Element
}): React.JSX.Element {
  return (
    <Tooltip label={label} delayMs={500}>
      <button
        type="button"
        className={css.button}
        title={label}
        aria-label={label}
        aria-pressed={pressed}
        onClick={onClick}
      >
        {icon}
      </button>
    </Tooltip>
  )
}

/**
 * 渲染文件侧栏与终端底栏两个常驻开关。
 * @param props - 品牌行 owner share、当前会话状态源与开关动作、本地化文案。
 * @returns 两个开关；没有可操作的会话时返回 null。
 */
export function WorkbenchPanelToggles(props: WorkbenchPanelTogglesProps): React.JSX.Element | null {
  const { wide, workbenchSource, toggleFiles, toggleBottom, useSessions, t } = props
  const sessionId = useSessions((state) => {
    const current = state.current
    return current !== undefined && state.byId[current] !== undefined ? current : undefined
  })
  const source = useMemo(
    () => (sessionId === undefined ? undefined : workbenchSource(sessionId)),
    [sessionId, workbenchSource],
  )
  const workbench = useWorkbenchLayout(source)
  if (sessionId === undefined) return null
  const filesOn = workbench.open && workbench.filesOpen
  const bottomOn = workbench.open && workbench.bottomOpen
  const iconSize = wide ? 16 : 18
  return (
    <div className={css.root} {...wide ? {} : { 'data-rail': true }}>
      <PanelButton
        label={filesOn ? t('workbench.files.hide') : t('workbench.files.show')}
        pressed={filesOn}
        onClick={toggleFiles}
        icon={<Icon name="files-panel" size={iconSize} />}
      />
      <PanelButton
        label={bottomOn ? t('workbench.bottom.hide') : t('workbench.bottom.show')}
        pressed={bottomOn}
        onClick={toggleBottom}
        icon={<Icon name="bottom-panel" size={iconSize} />}
      />
    </div>
  )
}
