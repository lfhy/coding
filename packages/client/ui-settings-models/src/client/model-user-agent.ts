/** 模型请求 UA 行的派生状态；持久值由 llm 设置分节拥有。 */
import { createSnapshotStore, type SettingsScope, type SnapshotStore } from 'coding-client-runtime/client'

/** 通用设置中的模型请求 UA 状态。 */
export interface ModelUserAgentState {
  status: 'loading' | 'ready' | 'unavailable'
  value: string
  overridden: boolean
  writable: boolean
  saving: boolean
  error: boolean
}

/** 根据 llm 分节快照投影状态并提交单字段写入。 */
export class ModelUserAgentController {
  readonly store: SnapshotStore<ModelUserAgentState>
  private saving = false
  private disposed = false
  private readonly unsubscribe: () => void

  /** @param scope - 与该插件生命周期绑定的 llm 设置分节。 */
  constructor(private readonly scope: SettingsScope<{ userAgent?: string }>) {
    this.store = createSnapshotStore<ModelUserAgentState>({
      status: 'loading', value: '', overridden: false, writable: false, saving: false, error: false,
    })
    this.unsubscribe = scope.subscribe(() => { this.publish() })
    this.publish()
  }

  /** 插件卸载后停止观察设置分节，并阻止迟到的写入结果发布。 */
  dispose(): void {
    this.disposed = true
    this.unsubscribe()
  }

  /**
   * 保存 UA 覆盖；空字符串清除覆盖，恢复产品默认值。
   * @param value - 已经通过表单校验的文本。
   * @returns 写入完成且镜像反映目标值时为 true。
   */
  async save(value: string): Promise<boolean> {
    const snapshot = this.scope.getSnapshot()
    if (this.disposed || this.saving || snapshot.status !== 'ready' || !snapshot.writable) return false
    this.saving = true
    this.store.update((state) => { state.saving = true; state.error = false })
    try {
      if (value === '') await this.scope.unset('userAgent')
      else await this.scope.set('userAgent', value)
      const updated = this.scope.getSnapshot()
      const success = updated.status === 'ready'
        && (value === ''
          ? !Object.hasOwn(updated.user ?? {}, 'userAgent')
          : (updated.user as { userAgent?: string } | undefined)?.userAgent === value)
      this.store.update((state) => { state.error = !success })
      return success
    } catch {
      this.store.update((state) => { state.error = true })
      return false
    } finally {
      this.saving = false
      this.publish()
    }
  }

  private publish(): void {
    if (this.disposed) return
    const scope = this.scope.getSnapshot()
    this.store.update((state) => {
      state.status = scope.status
      state.value = scope.value?.userAgent ?? ''
      state.overridden = Object.hasOwn(scope.user ?? {}, 'userAgent')
      state.writable = scope.writable
      state.saving = this.saving
    })
  }
}
