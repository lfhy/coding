/**
 * 设置面板的跨插件请求面（`ctx.settingsPanel`）：设置页由设置外壳渲染，
 * 但模型选择等入口需要把用户直接带到某个分区。可见状态与请求动作归设置底座
 * 所有，外壳只订阅快照并渲染，因此持有偏好设置的功能不必依赖外壳呈现包；
 * 底座也不因此引入布局、主题等 `ui-*` 依赖。
 */
import { Service } from '@deepseek-ai/cordis'
import type { Context } from '@deepseek-ai/cordis'
import {
  createSnapshotStore, type ObservableSnapshot, type SnapshotStore,
} from 'coding-client-runtime/client'

/** 设置面板的可见状态。 */
export interface SettingsPanelState {
  /** 设置页是否已挂载。 */
  open: boolean
  /** 当前定位的分区 id；undefined 表示展示导航中的第一个分区。 */
  section: string | undefined
}

/** 跨插件可读的设置面板状态与请求动作。 */
export interface ISettingsPanel {
  /** 当前可见状态；快照在状态变化前保持同一引用。 */
  readonly state: ObservableSnapshot<SettingsPanelState>
  /**
   * 请求打开设置页并定位到指定分区。
   * @param section - 目标分区 id；省略时沿用导航中的第一个分区。
   */
  open(section?: string): void
  /**
   * 在设置页内切换分区。
   * @param section - 目标分区 id。
   */
  select(section: string): void
  /** 关闭设置页并清空定位，下次打开回到默认分区。 */
  close(): void
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** 设置页的可见状态与跨插件打开请求。 */
    settingsPanel: SettingsPanelController
  }
}

const CLOSED: SettingsPanelState = { open: false, section: undefined }

/**
 * `ctx.settingsPanel` 的状态源：外壳订阅 {@link ISettingsPanel.state}，
 * 其他功能包只发请求，不直接读写外壳的 React 状态。
 * 状态用普通字段保存：调用经 Cordis 服务代理间接执行，`this` 是调用方上下文的
 * 影子对象，ES 私有字段（`#state`）在这条路径上不可读。
 */
export class SettingsPanelController extends Service implements ISettingsPanel {
  private readonly store: SnapshotStore<SettingsPanelState>

  readonly state: ObservableSnapshot<SettingsPanelState>

  /** @param ctx - 提供该服务的设置底座上下文。 */
  constructor(ctx: Context) {
    super(ctx, 'settingsPanel')
    this.store = createSnapshotStore<SettingsPanelState>(CLOSED)
    this.state = this.store
  }

  /**
   * 打开设置页；已在该分区上时不触发通知。
   * @param section - 目标分区 id，省略时由外壳选中第一个分区。
   * @returns 无返回值。
   */
  open(section?: string): void {
    const current = this.store.getSnapshot()
    if (current.open && current.section === section) return
    this.store.set({ open: true, section })
  }

  /**
   * 切换到另一个分区；未打开时也会先打开，避免请求被静默丢弃。
   * @param section - 目标分区 id。
   * @returns 无返回值。
   */
  select(section: string): void {
    this.open(section)
  }

  /**
   * 关闭设置页并清空定位。
   * @returns 无返回值。
   */
  close(): void {
    if (!this.store.getSnapshot().open) return
    this.store.set(CLOSED)
  }
}
