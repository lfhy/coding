/**
 * 新会话的预设暂存与标准对话准备。工作入口的选择只应用一次；独立对话
 * 在导航前撤回旧选择并等待已发出的切换，避免迟到回执覆盖标准模式。
 */

import type { IApiClient } from 'coding-api-remotes/client'
import {
  createSnapshotStore, type SessionId, type SnapshotStore,
} from 'coding-client-runtime/client'
import { messageOf, presetOptions, readRoster } from './settings-store.ts'
import type { AgentPresetOption } from './settings-store.ts'

/** Hero-chip snapshot. */
export interface AgentPresetSeatState {
  /** Presets the deployment supplies; empty means the chip renders nothing. */
  options: readonly AgentPresetOption[]
  /** The staged choice, empty until the roster loads. */
  current: string
  /** A rejected apply's message, cleared by the next attempt. */
  error: string | null
  busy: boolean
  /**
   * One-shot cue that the chip should introduce itself (the creator-draft
   * entry staged the pick from another screen, so the user never touched the
   * chip); the renderer clears it via `introduced()` once played.
   */
  introduce: boolean
}

const INITIAL: AgentPresetSeatState = {
  options: [], current: '', error: null, busy: false, introduce: false,
}

/** One session's identity and whether it has started. */
export interface SeatSessionSummary {
  /** The session the chip would apply its staged choice to. */
  id: SessionId
  /** False once a turn has run — applying is refused from then on. */
  blank: boolean
  /** The preset the session already runs, when the summary reports one. */
  agentPreset?: string
}

/** Stages the next session's preset and applies it when one appears. */
export class AgentPresetSeatController {
  /** Chip snapshot the renderer subscribes to. */
  readonly store: SnapshotStore<AgentPresetSeatState> = createSnapshotStore(INITIAL)

  /**
   * The deployment default, so a consumed stage can fall back to it without
   * re-reading the roster.
   */
  private fallback = ''

  /** Set while a pick is waiting for a session; cleared once applied. */
  private staged: string | undefined
  private loadGeneration = 0
  /** 会话摘要通知可能重入 apply；所有观察者等待同一个在途切换。 */
  private applying: Promise<void> | undefined
  /** 准备期间禁止列表订阅应用新暂存；计数覆盖重叠的导航请求。 */
  private preparing = 0

  constructor(
    private readonly api: Pick<IApiClient, 'agentPresets'>,
    /** The session the hero is about to hand over to, when there is one. */
    private readonly currentSession: () => SeatSessionSummary | undefined,
    /**
     * Publish an applied switch into the session list, so the header label
     * moves with the composition instead of waiting for the next full list
     * refresh. Optional: a harness that renders no list omits it.
     */
    private readonly onApplied?: (sessionId: string, agentPreset: string) => void,
  ) {}

  private set(patch: Partial<AgentPresetSeatState>): void {
    this.store.set({ ...this.store.getSnapshot(), ...patch })
  }

  /**
   * Read the roster and open the chip on the deployment default.
   * @returns once the snapshot reflects the host.
   */
  async load(): Promise<void> {
    const generation = ++this.loadGeneration
    try {
      const response = await this.api.agentPresets.list({})
      if (generation !== this.loadGeneration) return
      if (!response.result.ok) {
        this.set({ error: response.result.error.message })
        return
      }
      const { presets } = response.result.value
      const options = presetOptions(presets)
      // 预设可能在暂存后因图像服务被关闭而从可选名单消失；旧选择不可
      // 套用到新会话。当前空白会话自己的模式仍要如实显示以便切走。
      if (this.staged !== undefined && !options.some(option => option.id === this.staged)) {
        this.staged = undefined
      }
      this.fallback = presets.find(preset => preset.isDefault)?.id ?? presets[0]?.id ?? ''
      this.set({
        options,
        // 暂存选择优先，其次是当前会话已运行的模式，最后是部署默认值；
        // 名单迟到时不能把已完成切换的显示回退成默认值。
        current: this.staged ?? this.currentSession()?.agentPreset ?? this.fallback,
        error: null,
      })
    } catch (error) {
      if (generation !== this.loadGeneration) return
      this.set({ error: messageOf(error) })
    }
  }

  /**
   * Stage one preset for the next session, applying it immediately when a
   * blank session is already current.
   * @param id - the preset to stage.
   * @returns once the stage settled, and the apply too when one happened.
   */
  async select(id: string): Promise<void> {
    if (this.store.getSnapshot().busy) return
    this.stage(id)
    await this.apply()
  }

  /**
   * Stage a pick WITHOUT the immediate apply, for a flow that starts the
   * receiving session after the pick (the settings section's creator entry).
   * `select()`'s immediate apply would meet the still-current running session
   * and drop the stage as unservable; staging alone leaves it for the
   * list-change applier, which fires when the started session becomes
   * current.
   * @param id - the preset to stage.
   * @param introduce - true when the stage came from another screen and the
   * chip should announce itself on the session it lands on.
   */
  stage(id: string, introduce = false): void {
    this.staged = id
    this.set({ current: id, error: null, introduce })
  }

  /** Acknowledge the introduction cue once the chip has played it. */
  introduced(): void {
    if (!this.store.getSnapshot().introduce) return
    this.set({ introduce: false })
  }

  /**
   * 将暂存选择交给当前空白会话；列表重入共用在途请求，标准入口准备时不应用。
   * @returns 切换完成；没有可接收的会话时立即完成。
   */
  async apply(): Promise<void> {
    if (this.applying !== undefined) return this.applying
    if (this.preparing > 0) return
    const staged = this.staged
    const session = this.currentSession()
    if (staged === undefined || session === undefined) return
    // 先消费暂存，避免摘要通知或旧请求回执将同一选择再次套到别的会话。
    this.staged = undefined
    if (!session.blank || session.agentPreset === staged) return
    this.applying = this.applyPreset(session.id, staged).finally(() => { this.applying = undefined })
    return this.applying
  }

  /** 工作模式的切换错误留在选择器中，不改变既有 select/apply 的失败契约。 */
  private async applyPreset(sessionId: SessionId, preset: string): Promise<void> {
    this.set({ busy: true, error: null })
    try {
      const response = await this.api.agentPresets.select({ sessionId, agentPreset: preset })
      if (!response.result.ok) {
        this.set({ error: response.result.error.message, current: this.fallback })
        return
      }
      this.set({ current: response.result.value.agentPreset })
      this.onApplied?.(sessionId, response.result.value.agentPreset)
    } catch (error) {
      this.set({ error: messageOf(error), current: this.fallback })
    } finally {
      this.set({ busy: this.preparing > 0 })
    }
  }

  /**
   * 在独立对话导航前为明确的目标空白会话准备标准模式，不改部署默认值。
   * Host 仍负责拒绝已开始的会话；失败必须传给入口，禁止释放草稿与导航锁。
   * @param sessionId - 入口连接出的目标，不一定是当前会话。
   * @returns 旧切换已结算且目标已确认标准模式；无预设部署无需切换。
   */
  async prepareStandard(sessionId: SessionId): Promise<void> {
    this.staged = undefined
    this.loadGeneration++
    this.preparing++
    this.set({ busy: true, error: null, introduce: false })
    try {
      await this.applying
      const roster = await readRoster(this.api)
      if (!roster.ok) throw new Error(roster.error)
      const { presets } = roster.value
      const options = presetOptions(presets)
      this.fallback = presets.find(preset => preset.isDefault)?.id ?? presets[0]?.id ?? ''
      this.set({ options })
      if (presets.length === 0) {
        this.set({ current: '' })
        return
      }
      if (!options.some(option => option.id === 'standard')) {
        throw new Error('标准模式暂不可用，请检查模式配置后重试。')
      }
      const response = await this.api.agentPresets.select({ sessionId, agentPreset: 'standard' })
      if (!response.result.ok) throw new Error(response.result.error.message)
      this.set({ current: response.result.value.agentPreset, error: null })
      this.onApplied?.(sessionId, response.result.value.agentPreset)
    } catch (error) {
      this.set({ error: messageOf(error), current: this.fallback })
      throw error
    } finally {
      this.preparing--
      this.set({ busy: this.preparing > 0 })
    }
  }
}
