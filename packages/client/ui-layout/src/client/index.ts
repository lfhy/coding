/**
 * 布局插件的浏览器入口。一次 root 注册同时声明子 slot、创建布局 store，
 * 并将绑定 actions 接到 `ctx.layout`；独立 effect 负责主题 DOM 投影。
 */
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-ui-theme/client'
import type { AppFrameInjected } from './AppFrame.tsx'
import type { PanelActions } from './service.ts'
import { AppFrame } from './AppFrame.tsx'
import { createLayoutStore } from './stores.ts'
import { LayoutController } from './service.ts'
import { ThemePresenter } from './theme-presenter.ts'

export { LayoutController } from './service.ts'
export type { ILayout, WorkbenchLayoutSnapshot } from './service.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** 客户端布局的跨插件动作。 */
    layout: import('./service.ts').ILayout
  }
}

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotMap {
    /** 整个左侧导航栏；占用者负责展开态和紧凑 rail。 */
    'sidebar': { kind: 'single'; scope: 'root'; owner: SidebarOwnerProps }
    /** 对话主区域；无当前会话时仍保持同一个 `session-maybe` entry。 */
    'conversation': { kind: 'single'; scope: 'session-maybe'; owner: ConvOwnerProps }
    /** 既有会话详情栏；工作台打开时保持挂载但不参与布局。 */
    'details': { kind: 'single'; scope: 'session'; owner: DetailsOwnerProps }
    /**
     * 会话级固定工作台右栏。占用者绘制文件预览与顶栏视图控制；页头入口在会话层打开工作台；关闭时 entry 保持挂载。
     */
    'workbench': { kind: 'single'; scope: 'session'; owner: WorkbenchOwnerProps }
    /** 会话级工作台底栏；在视觉关闭时保持挂载。 */
    'workbench.bottom': { kind: 'single'; scope: 'session'; owner: WorkbenchBottomOwnerProps }
    /** 全框架浮层；容器透传指针事件，由各 entry 自行恢复。 */
    'shell.overlay': { kind: 'list'; scope: 'root' }
  }
}

/** 导航栏 owner share。 */
export interface SidebarOwnerProps {
  /** 是否显示紧凑 rail。 */
  collapsed: boolean
  /** 实际渲染宽度。 */
  width: number
  /** 欢迎页右上角可操作时，品牌行不再重复显示面板按钮。 */
  welcomeActionsVisible: boolean
}

/** 对话区域需要知道侧边栏的实际收起状态，以呈现欢迎页入口。 */
export interface ConvOwnerProps {
  /** 响应式折叠后的实际状态，而非用户保存的宽度偏好。 */
  sidebarCollapsed: boolean
}

/** 详情栏没有额外 owner 数据；会话 id 由框架提供。 */
export interface DetailsOwnerProps {}

/** 工作台右栏 owner share。 */
export interface WorkbenchOwnerProps {
  /** 当前会话的工作台是否可见。 */
  shown: boolean
  /** 是否实际占据全部主内容；窄屏会自动进入该呈现。 */
  fullscreen: boolean
  /** 底栏是否实际可见。 */
  bottomOpen: boolean
  /** 工作台内文件侧栏是否可见。 */
  filesOpen: boolean
}

/** 工作台底栏 owner share。 */
export interface WorkbenchBottomOwnerProps {
  /** 底栏是否实际可见。 */
  shown: boolean
}

/** Cordis fiber 所需服务。 */
export const inject = ['slots', 'theme']

/**
 * 注册 AppFrame、`ctx.layout` 和主题呈现器。
 * @param ctx - 客户端根 Context。
 * @returns 无返回值；生命周期由 `ctx.effect` 管理。
 */
export function apply(ctx: ClientContext): void {
  const layout = new LayoutController()
  ctx.effect(() => {
    const disposeService = ctx.reflect.provide('layout', layout)
    const disposeRegistration = ctx.slots.register({
      name: 'root',
      children: {
        'sidebar': { kind: 'single', scope: 'root' },
        'conversation': { kind: 'single', scope: 'session-maybe' },
        'details': { kind: 'single', scope: 'session' },
        'workbench': { kind: 'single', scope: 'session' },
        'workbench.bottom': { kind: 'single', scope: 'session' },
        'shell.overlay': { kind: 'list', scope: 'root' },
      },
      store: createLayoutStore,
      inject: (actions: PanelActions): AppFrameInjected => {
        layout.attachPanels(actions)
        return {
          publishWorkbench: (sessionId, state) => { layout.publishWorkbench(sessionId, state) },
          retainWorkbenchViews: (sessionIds) => { layout.retainWorkbenchViews(sessionIds) },
        }
      },
    }, AppFrame)
    return () => {
      disposeRegistration()
      void disposeService()
    }
  }, 'ui-layout: service + root registration')

  ctx.effect(() => {
    const presenter = new ThemePresenter()
    presenter.apply(ctx.theme.getTheme())
    const off = ctx.on('theme/change', (snapshot) => { presenter.apply(snapshot) })
    return () => {
      off()
      presenter.dispose()
    }
  }, 'ui-layout: theme presenter')
}
