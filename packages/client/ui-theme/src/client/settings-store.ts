/**
 * 外观行的 slot store：主题运行时快照的镜像。
 *
 * 插件体的变化监听是唯一写入方；行组件经 `props.useStore` 读。`preference`
 * 决定选中态，`scheme` 只在选择的是某个主题预设时用来点亮"当前明暗"的方块。
 */
import { defineStore, type EngineStoreHandle } from 'coding-client-runtime/client'
import type { ThemeSelection } from '../theme-settings.ts'

/** 从主题快照镜像出来的外观行状态。 */
export interface AppearanceRowState {
  /** 持久化的选择（内置偏好或主题预设 id）。 */
  preference: ThemeSelection
  /** 解析后的明暗；选择为预设时用它与三个方块对齐。 */
  scheme: 'light' | 'dark'
  /** 服务序号；-1 表示还没同步过，让第一帧的 0 能落到 store。 */
  revision: number
}

/** 声明的写入口形状，保证工厂返回类型稳定。 */
type AppearanceRowActions = {
  sync: (draft: AppearanceRowState, preference: ThemeSelection, scheme: 'light' | 'dark', revision: number) => void
}

/**
 * 声明外观行状态与写入面。
 * @returns 外观行 store 句柄。
 */
export function createAppearanceRowStore(): EngineStoreHandle<AppearanceRowState, AppearanceRowActions> {
  return defineStore({
    init: (): AppearanceRowState => ({ preference: 'system', scheme: 'light', revision: -1 }),
    actions: {
      sync: (d, preference, scheme, revision) => {
        if (revision <= d.revision) return
        d.preference = preference
        d.scheme = scheme
        d.revision = revision
      },
    },
  })
}
