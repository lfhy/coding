import { useEffect, useRef, useState } from 'react'
import {
  IconChevronDownOutline14,
  IconFolderOpenOutline16,
  Menu,
  Tooltip,
  type MenuItem,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-runtime/client'
import type { InjectFace, PropsLocale, PropsRuntime, PropsStore } from '@deepseek-ai/dsh-client-ui-slots'
import type { WorkbenchLayoutSnapshot } from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { OpenInAppOpenResult } from '@deepseek-ai/dsh-host-open-in-app/shared'
import { NS, type OpenInAppKey } from './locales.ts'
import {
  WORKBENCH_CHOICE_ID,
  resolveOpenChoice,
  type WorkspaceOpenTargets,
} from './controller.ts'
import type { createWorkbenchStore } from './store.ts'
import css from './OpenInAppAction.module.css'

/** 注入会话头部工作区打开控件和布局动作的浏览器操作。 */
export interface OpenInAppActionInjected {
  hooks: {
    openInAppTargets: ObservableSnapshot<WorkspaceOpenTargets>
    openInAppChoice: ObservableSnapshot<string>
    workbenchLayout: ObservableSnapshot<WorkbenchLayoutSnapshot>
  }
  load: (path: string) => Promise<void>
  launch: (appId: string, path: string) => Promise<OpenInAppOpenResult['action']>
  choose: (appId: string) => void
  iconUrl: (appId: string) => string
  openWorkbench: () => void
}

/** 会话页头工作区打开控件与当前 Session 的工作台显隐。 */
export type OpenInAppActionProps =
  PropsRuntime<'conversation.session.header.utilities'>
  & PropsStore<ReturnType<typeof createWorkbenchStore>>
  & PropsLocale<typeof NS>
  & InjectFace<OpenInAppActionInjected>

/** catalog id 到本地化名称的封闭映射；词典不认识的 Host 扩展不会显示裸 id。 */
const APP_LABEL_KEY: Record<string, OpenInAppKey | undefined> = {
  finder: 'app.finder',
  explorer: 'app.explorer',
  filemanager: 'app.filemanager',
  cursor: 'app.cursor',
  vscode: 'app.vscode',
  vscodeinsiders: 'app.vscodeinsiders',
  windsurf: 'app.windsurf',
  zed: 'app.zed',
  sublimetext: 'app.sublimetext',
  xcode: 'app.xcode',
  androidstudio: 'app.androidstudio',
  intellij: 'app.intellij',
  pycharm: 'app.pycharm',
  webstorm: 'app.webstorm',
  phpstorm: 'app.phpstorm',
  goland: 'app.goland',
  rider: 'app.rider',
  rustrover: 'app.rustrover',
  fork: 'app.fork',
  sourcetree: 'app.sourcetree',
  github: 'app.github',
  tower: 'app.tower',
  gitkraken: 'app.gitkraken',
  smartgit: 'app.smartgit',
  sublimemerge: 'app.sublimemerge',
  ghostty: 'app.ghostty',
  warp: 'app.warp',
  iterm: 'app.iterm',
  kitty: 'app.kitty',
  terminal: 'app.terminal',
  windowsterminal: 'app.windowsterminal',
  gitbash: 'app.gitbash',
  gnometerminal: 'app.gnometerminal',
  konsole: 'app.konsole',
}

/** 本页面内已经加载失败的应用图标；404 不会在每次打开菜单时重复请求。 */
const failedIcons = new Set<string>()

/**
 * 显示 Host 提供的应用图标；没有图标时回退到通用应用方框。
 * @param props - catalog id、Host 图标 URL 和显示尺寸。
 * @returns 应用图标或通用 fallback。
 */
function AppIcon({ id, url, size }: { id: string; url: string; size: number }): React.JSX.Element {
  const [failed, setFailed] = useState(failedIcons.has(id))
  if (failed) {
    return (
      <svg
        width={size}
        height={size}
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={1.8}
        className={css.icon}
        aria-hidden
      >
        <rect x={3} y={3} width={18} height={18} rx={5} />
      </svg>
    )
  }
  return (
    <img
      src={url}
      width={size}
      height={size}
      className={css.icon}
      alt=""
      aria-hidden
      draggable={false}
      onError={() => {
        failedIcons.add(id)
        setFailed(true)
      }}
    />
  )
}

/** 快速启动不绘制等待态；只有超过该延迟的请求才使按钮变暗。 */
const BUSY_DRESS_DELAY_MS = 250

/**
 * 会话头部的工作区打开入口：本地工作区显示分体按钮，主按钮打开内置文件
 * 工作台，菜单可在内置工作台与 Host 已验证的应用之间切换；Remote-SSH 或
 * SSH Host 只显示内置工作台按钮。Host 未确认目标前不渲染，避免错误地把远端
 * 路径交给本机应用。工作台打开后入口只保留固定按钮；全屏或窄屏隐藏会话
 * 页头时，工作台顶栏提供面板开关、最大化和关闭动作。
 * @param props - Session runtime、目标 controller、工作台打开动作和本地化文案。
 * @returns 当前工作区可用的入口；无 cwd 或目标不可用时返回 null。
 */
export function OpenInAppAction(props: OpenInAppActionProps): React.JSX.Element | null {
  const {
    sessionId,
    useSessions,
    useOpenInAppTargets,
    useOpenInAppChoice,
    useWorkbenchLayout,
    t,
  } = props
  const cwd = useSessions(state => state.byId[sessionId]?.cwd)
  const target = useOpenInAppTargets(targets => cwd === undefined ? undefined : targets[cwd])
  const choice = useOpenInAppChoice(id => id)
  const workbench = useWorkbenchLayout(state => state)
  const [open, setOpen] = useState(false)
  const [phase, setPhase] = useState<'idle' | 'busy' | 'error'>('idle')
  const inFlight = useRef(false)
  const busyTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const errorTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  useEffect(() => {
    if (cwd !== undefined && cwd !== '') void props.load(cwd)
  }, [cwd, props.load])

  useEffect(() => () => {
    inFlight.current = false
    clearTimeout(busyTimer.current)
    clearTimeout(errorTimer.current)
  }, [])

  if (cwd === undefined || cwd === '' || target === undefined
    || target.kind === 'loading' || target.kind === 'unavailable') return null

  if (workbench.open || target.kind === 'files') {
    return (
      <div className={css.entry}>
        <Tooltip label={t('workbench.open.tooltip')} side="bottom">
          <button
            type="button"
            className={css.filesButton}
            aria-label={t('workbench.open.title')}
            {...workbench.open ? { 'aria-pressed': true } : {}}
            onClick={() => { props.openWorkbench() }}
          >
            <IconFolderOpenOutline16 size={16} />
          </button>
        </Tooltip>
      </div>
    )
  }

  const apps = target.apps
    .map(id => ({ id, labelKey: APP_LABEL_KEY[id] }))
    .filter((entry): entry is { id: string; labelKey: OpenInAppKey } => entry.labelKey !== undefined)
  const current = resolveOpenChoice(choice, apps.map(entry => entry.id))
  const currentApp = apps.find(entry => entry.id === current)
  const appLabel = currentApp === undefined ? undefined : t(currentApp.labelKey)
  const title = phase === 'error'
    ? t('open.error')
    : appLabel === undefined ? t('workbench.open.title') : t('open.title', { app: appLabel })
  const mainTooltip = phase === 'error'
    ? t('open.error')
    : appLabel === undefined ? t('workbench.open.tooltip') : t('open.tooltip')

  const launch = (appId: string): void => {
    if (inFlight.current) return
    inFlight.current = true
    clearTimeout(errorTimer.current)
    clearTimeout(busyTimer.current)
    busyTimer.current = setTimeout(() => { setPhase('busy') }, BUSY_DRESS_DELAY_MS)
    props.launch(appId, cwd).then((action) => {
      inFlight.current = false
      clearTimeout(busyTimer.current)
      setPhase('idle')
      if (action === 'files') props.openWorkbench()
    }, () => {
      inFlight.current = false
      clearTimeout(busyTimer.current)
      setPhase('error')
      clearTimeout(errorTimer.current)
      errorTimer.current = setTimeout(() => { setPhase('idle') }, 2_000)
    })
  }

  const items: MenuItem[] = [
    { id: WORKBENCH_CHOICE_ID, label: t('workbench.label'), icon: <IconFolderOpenOutline16 size={18} /> },
    ...apps.map(entry => ({
      id: entry.id,
      label: t(entry.labelKey),
      icon: <AppIcon id={entry.id} url={props.iconUrl(entry.id)} size={18} />,
    })),
  ]

  return (
    <div className={css.entry}>
      <Menu
        open={open}
        align="end"
        dense
        onClose={() => { setOpen(false) }}
        items={items}
        selectedId={current}
        onSelect={(id) => {
          setOpen(false)
          if (inFlight.current) return
          props.choose(id)
          if (id === WORKBENCH_CHOICE_ID) {
            props.openWorkbench()
            return
          }
          launch(id)
        }}
        anchor={(
          <div className={css.split}>
            <Tooltip label={mainTooltip} side="bottom">
              <button
                type="button"
                className={css.main}
                data-state={phase}
                disabled={phase === 'busy'}
                aria-label={title}
                onClick={() => {
                  if (currentApp === undefined) props.openWorkbench()
                  else launch(currentApp.id)
                }}
              >
                {currentApp === undefined
                  ? <IconFolderOpenOutline16 size={16} />
                  : <AppIcon id={currentApp.id} url={props.iconUrl(currentApp.id)} size={16} />}
              </button>
            </Tooltip>
            <button
              type="button"
              className={css.chevron}
              aria-expanded={open}
              aria-haspopup="menu"
              title={t('menu.toggle')}
              aria-label={t('menu.toggle')}
              onClick={() => { setOpen(value => !value) }}
            >
              <IconChevronDownOutline14 size={11} />
            </button>
          </div>
        )}
      />
    </div>
  )
}
