/**
 * 设置外壳契约：本包占用布局持有的 `shell.settings`，并声明设置页面的组合属性。
 * 外壳类型留在这里，避免设置领域底座依赖布局等呈现包而形成引用环；
 * 各功能贡献的设置 slot 类型仍由 ui-settings 持有。
 */
import type { HostObservable, InjectFace, PropsLocale, PropsRenderSlots, PropsRuntime } from 'coding-client-ui-slots'
// 仅类型导入：引入布局持有的 shell.settings slot 声明。
import type {} from 'coding-client-ui-layout/client'
// 仅类型导入：引入外壳渲染的设置子 slot 声明，并读取设置底座的页面状态类型。
import type { SettingsPanelState } from 'coding-client-ui-settings/client'

/** 从 settings.section 注册选项投影的一行导航。 */
export interface SettingsSectionRow {
  id: string
  order: number
  label: string
}

/** 从 slot 注册项投影的有序引导步骤。 */
export interface SettingsOnboardingStep {
  id: string
  order: number
}

/**
 * 设置外壳在 apply 中组装的私有注入：导航与引导账本经 hooks 分区发布，
 * 组件通过框架绑定的钩子订阅，不自行管理外部订阅。
 */
export type SettingsRootInjected = {
  hooks: {
    /** settings.section 账本投影的有序导航行。 */
    sections: HostObservable<readonly SettingsSectionRow[]>
    /** settings.onboarding 账本投影的引导顺序。 */
    onboardingSteps: HostObservable<readonly SettingsOnboardingStep[]>
    /** 设置底座的页面状态：开关与当前分区由跨插件请求共同驱动。 */
    panel: HostObservable<SettingsPanelState>
  }
  /** 打开设置页并定位到指定分区；引导步骤与其他入口共用这一动作。 */
  openPanel: (section?: string) => void
  /** 切换当前分区；不改变设置页开关。 */
  selectPanelSection: (section: string) => void
  /** 关闭设置页；返回控件与 Escape 共用这一动作。 */
  closePanel: () => void
}

/**
 * 设置外壳完整属性：窗口导航的宽行／图标状态、子 slot、私有注入与本地化能力。
 * 不注册 store；设置页开关与当前分区来自设置底座的状态源，只有已完成引导
 * 属于组件本地状态。
 */
export type SettingsRootComponentProps =
  PropsRuntime<'shell.settings'>
  & PropsRenderSlots<
    | 'settings.trigger'
    | 'settings.header'
    | 'settings.action'
    | 'settings.close'
    | 'settings.section'
    | 'settings.onboarding'
  >
  & InjectFace<SettingsRootInjected>
  & PropsLocale<'settings'>
