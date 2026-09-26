/** 会话页头与欢迎页的文件侧栏、终端底栏开关。 */
import { useMemo, useState, useCallback, useSyncExternalStore } from 'react'
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-runtime/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { WorkbenchLayoutSnapshot } from '@deepseek-ai/dsh-client-ui-layout/client'
import { Icon, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { NS } from './locales.ts'
import css from './WorkbenchPanelToggles.module.css'

/** 会话页头注入的当前 Session 工作台状态与面板动作。 */
export interface WorkbenchPanelTogglesInjected {
  hooks: { workbenchLayout: ObservableSnapshot<WorkbenchLayoutSnapshot> }
  /** 切换当前 Session 的文件侧栏；工作台未打开时先打开工作台。 */
  toggleFiles: () => void
  /** 切换当前 Session 的终端底栏；工作台未打开时先打开工作台。 */
  toggleBottom: () => void
}

/** 会话页头开关的 slot props。 */
export type WorkbenchPanelTogglesProps =
  & PropsRuntime<'conversation.session.header.utilities'>
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

/** 欢迎页单个面板按钮的状态源与打开动作。 */
export interface HeroPanelToggleInjected {
  workbenchSource: (sessionId: SessionId) => ObservableSnapshot<WorkbenchLayoutSnapshot>
  panel: 'bottom' | 'files'
  togglePanel: () => Promise<void>
}

/**
 * 欢迎页右上角的面板入口；尚无 Session 时会先创建可用的空白会话。
 * @param props - 当前会话、工作台状态源、打开动作与本地化文案。
 * @returns 带按下状态和失败反馈的面板图标按钮。
 */
export function HeroPanelToggle({ useSessions, workbenchSource, panel, togglePanel, t }:
  PropsRuntime<'conversation.hero.actions'> & InjectFace<HeroPanelToggleInjected> & PropsLocale<typeof NS>) {
  const sessionId = useSessions(state => state.current)
  const source = useMemo(
    () => sessionId === undefined ? undefined : workbenchSource(sessionId),
    [sessionId, workbenchSource],
  )
  const workbench = useWorkbenchLayout(source)
  const pressed = panel === 'bottom' ? workbench.bottomOpen : workbench.open && workbench.filesOpen
  const [opening, setOpening] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const label = t(panel === 'bottom'
    ? opening ? 'workbench.bottom.opening' : pressed ? 'workbench.bottom.hide' : 'workbench.bottom.show'
    : opening ? 'workbench.files.opening' : pressed ? 'workbench.files.hide' : 'workbench.files.show')
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
            void togglePanel().catch((reason: unknown) => {
              setError(t(panel === 'bottom' ? 'workbench.bottom.failed' : 'workbench.files.failed', {
                message: reason instanceof Error ? reason.message : String(reason),
              }))
            }).finally(() => { setOpening(false) })
          }}
        >
          <Icon name={panel === 'bottom' ? 'bottom-panel' : 'files-panel'} size={18} />
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
 * 在会话页头右侧渲染文件侧栏与终端底栏开关。
 * @param props - 当前 Session 的布局投影、开关动作与本地化文案。
 * @returns 两个随布局状态更新的按钮。
 */
export function WorkbenchPanelToggles(props: WorkbenchPanelTogglesProps): React.JSX.Element {
  const { toggleFiles, toggleBottom, useWorkbenchLayout, t } = props
  const workbench = useWorkbenchLayout(state => state)
  const filesOn = workbench.open && workbench.filesOpen
  const bottomOn = workbench.bottomOpen
  return (
    <div className={css.root}>
      <PanelButton
        label={bottomOn ? t('workbench.bottom.hide') : t('workbench.bottom.show')}
        pressed={bottomOn}
        onClick={toggleBottom}
        icon={<Icon name="bottom-panel" size={18} />}
      />
      <PanelButton
        label={filesOn ? t('workbench.files.hide') : t('workbench.files.show')}
        pressed={filesOn}
        onClick={toggleFiles}
        icon={<Icon name="files-panel" size={18} />}
      />
    </div>
  )
}
