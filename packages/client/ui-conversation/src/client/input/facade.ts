/** 包内输入状态机壳：持有草稿、通知与提交事务，由 InputHub 构造并随会话释放。 */
import type { ClientContext, ObservableSnapshot, SnapshotStore } from 'coding-client-runtime/client'
import { createSnapshotStore } from 'coding-client-runtime/client'
import type {
  ArbitrateKey, ArbitrateOutcome, CommandClaim, ConsumeTokenRequest, PickOutcome,
  ReferenceInsert, InputTriggerController, SubmitImageAttachment, SubmitOutcome, TokenSpan,
} from 'coding-client-ui-input-trigger/client'
import type {
  DraftAttachmentId, EditRange, EditSelection, InputActions, InputEffect, InputNotice, InputState,
  Occurrence, PasteComponent, QueuedMessage, SessionInput, SubmitAttempt,
} from './contract.ts'
import type { InputSubmitMode } from '../contract/composer-submission.ts'
import { InputMachine, argsAfter, projectClipboard } from './machine.ts'
import { stagedPasteComponents } from './staged-reference.ts'
import { transferDraft } from './draft-transfer.ts'

/** Popup face the shell needs (dismissal only; typed structurally to avoid a value import). */
export interface PopupDismissFace {
  dismiss(): void
}

/** 会话 scope 尚在物化时无法寻址命令来源；相关依赖延迟到交互时解析。 */
export interface SessionInputDeps {
  /** Session-scope ctx handed to claim.submit transactions. */
  actx: ClientContext
  /** Enter adjudication face resolver; absent/undefined answer = every '/' line falls to the default sink. */
  inputTriggers?: (() => InputTriggerController | undefined) | undefined
  /** PopupSelect shell face resolver (dismissal on submit lock / escape). */
  popup?: (() => PopupDismissFace | undefined) | undefined
  /** Queue read face; overlaid onto InputState.queue (absent = empty). */
  queue?: ObservableSnapshot<readonly QueuedMessage[]> | undefined
  /**
   * Steer every still-pending queued message into the running turn, in FIFO
   * order (the empty-draft accelerated-Enter gesture); absent = unsupported.
   */
  steerQueue?: (() => void) | undefined
  /** The plain-message sink (send choreography / materialize fork — the hub owns it). */
  defaultSink(
    text: string,
    imageIds: readonly DraftAttachmentId[],
    mode: InputSubmitMode,
    signal: AbortSignal,
  ): Promise<SubmitOutcome>
  /** Command-plane image plumbing (the hub owns the conversation face and the copy). */
  commandImages: {
    /** Resolve ordered draft ids to wire payloads without sending them; rejects when an id no longer resolves. */
    serialize(ids: readonly DraftAttachmentId[]): Promise<readonly SubmitImageAttachment[]>
    /** Free consumed draft images after a successful command submit. */
    release(ids: readonly DraftAttachmentId[]): void
    /** Localized composer notice for a claimed command that does not accept images. */
    unsupportedNotice(token: string): string
  }
}

/** Guard tier from the machine phase. */
function guardOf(phase: InputState['phase']): 'plain' | 'claimed' | 'frozen' {
  switch (phase) {
    case 'plain': return 'plain'
    case 'claimed': return 'claimed'
    default: return 'frozen' // adjudicating / submitting
  }
}

const EMPTY_QUEUE: readonly QueuedMessage[] = []

/** No-pipeline lexicon: zero text-ref decorations. */
const EMPTY_LEXICON: ReadonlyMap<'/' | '@', readonly string[]> = new Map()

/** 逐会话输入动作与状态源；包内另提供草稿迁移和持久化镜像绑定。 */
export class SessionInputShell implements SessionInput {
  /** Published machine state + queue overlay (the InputZone currency source). */
  readonly state: SnapshotStore<InputState>
  /** Latest surfaced notice (null after clear); the bar renders errors as banners and information inline. */
  readonly notices: SnapshotStore<InputNotice | null> = createSnapshotStore<InputNotice | null>(null)
  /** 每次跨插件聚焦请求递增；不进入草稿或输入机器。 */
  readonly focusRequest: SnapshotStore<number> = createSnapshotStore(0)
  /** The public provide-channel action face (one stable identity per session). */
  readonly actions: InputActions = {
    setDraft: (text) => { this.setDraft(text) },
    addImages: ids => this.addImages(ids),
    removeImage: (id) => { this.removeImage(id) },
    pruneImages: (ids) => { this.pruneImages(ids) },
    submit: () => { this.submit('queue') },
  }

  // 真实时钟让连续输入的撤销合并窗口按时间过期。
  private readonly core = new InputMachine({ now: () => Date.now() })
  private noticeSeq = 0
  private focusSeq = 0
  private lastMirroredDraft = ''
  private imageIds: readonly DraftAttachmentId[] = []
  /** One image-only send at a time: Enter during the Host round-trip is a no-op. */
  private imageSendInFlight = false
  private disposed = false
  /** Draft persistence mirror (chat store write; receives the clipboard projection, never display-only ranges). */
  private mirrorFn: ((text: string) => void) | undefined

  constructor(private readonly deps: SessionInputDeps) {
    this.state = createSnapshotStore<InputState>(this.compose())
    deps.queue?.subscribe(() => { this.publish() })
  }

  /** 发布一次只针对本会话输入框的聚焦请求。 */
  requestFocus(): void {
    this.focusRequest.set(++this.focusSeq)
  }

  // ---- SessionInput face ----

  /**
   * 输入的普通编辑由状态机持有；首次恢复规范暂存路径时还原文件名展示引用。
   * @param text - 完整新草稿；会话存储中的完整路径不得被展示名覆盖。
   * @param editRange - 已知的 DOM 编辑区间；存在时不扫描恢复引用。
   */
  setDraft(text: string, editRange?: EditRange): void {
    if (this.core.state.draft === '' && text !== '' && editRange === undefined) {
      const components = stagedPasteComponents(text)
      if (components.length > 0) {
        this.pasteBegin(text, { start: 0, end: 0 }, components)
        this.invalidatePaste()
        return
      }
    }
    this.run(this.core.dispatch({ type: 'draft-changed', draft: text, ...(editRange !== undefined ? { editRange } : {}) }))
  }

  /** Append ordered image ids unless an admission transaction is locked. */
  addImages(ids: readonly DraftAttachmentId[]): boolean {
    if (this.snapshot.phase === 'adjudicating' || this.snapshot.phase === 'submitting') return false
    if (ids.length === 0) return true
    this.imageIds = [...this.imageIds, ...ids]
    this.publish()
    return true
  }

  /** 提交锁期间不允许移除图片，避免界面隐藏后仍被正在序列化的请求发送。 */
  removeImage(id: DraftAttachmentId): void {
    if (this.snapshot.phase === 'adjudicating' || this.snapshot.phase === 'submitting') return
    const next = this.imageIds.filter(candidate => candidate !== id)
    if (next.length === this.imageIds.length) return
    this.imageIds = next
    this.publish()
  }

  /**
   * Keep only image ids that still resolve in the browser attachment registry.
   * @param available - live registry ids.
   */
  pruneImages(available: readonly DraftAttachmentId[]): void {
    const keep = new Set(available)
    const next = this.imageIds.filter(id => keep.has(id))
    if (next.length === this.imageIds.length) return
    this.imageIds = next
    this.publish()
  }

  /**
   * Clear the draft as a successful-send commit: no undo unit is recorded and
   * the undo history is cut, so Ctrl/Cmd-Z cannot resurrect sent content
   * (the command path gets the same discipline from submit-settled success).
   * @param imageIds - admitted image ids to remove from this draft.
   */
  commitSend(imageIds: readonly DraftAttachmentId[]): void {
    const submitted = new Set(imageIds)
    this.imageIds = this.imageIds.filter(id => !submitted.has(id))
    this.run(this.core.dispatch({ type: 'send-committed' }))
  }

  /** Undo the latest transaction (InputBar intercepts the platform chord). */
  undo(): void {
    this.run(this.core.dispatch({ type: 'undo' }))
  }

  /** Redo the latest undone transaction. */
  redo(): void {
    this.run(this.core.dispatch({ type: 'redo' }))
  }

  /**
   * Paste text over the selection in one transaction, with any hot-snapshot
   * sync matches componentized inside it.
   * @param text - pasted plain text.
   * @param selection - replaced selection in draft coordinates.
   * @param components - sync-matched reference components (disjoint, inside `text`).
   * @param generation - projection generation for late async-upgrade guards.
   */
  pasteBegin(text: string, selection: EditSelection, components?: readonly PasteComponent[], generation?: number): void {
    this.run(this.core.dispatch({
      type: 'paste-begin', text, selection,
      ...(components !== undefined ? { components } : {}),
      ...(generation !== undefined ? { generation } : {}),
    }))
  }

  /** End the live paste-match attempt (caret/selection ops and Slash updates the machine cannot see). */
  invalidatePaste(): void {
    this.run(this.core.dispatch({ type: 'invalidate-paste' }))
  }

  /**
   * Enter adjudication + submit transaction + default sink. Effects fan out
   * from the machine; this method only feeds the event. Lock entry
   * (adjudicating/submitting) force-closes the transient layers: the popup
   * dismisses and the menu tracks frozen.
   */
  submit(mode: InputSubmitMode = 'queue'): void {
    if (this.snapshot.draft.trim() === '' && this.imageIds.length > 0) {
      if (this.snapshot.phase === 'plain' && !this.imageSendInFlight) {
        const imageIds = [...this.imageIds]
        this.imageSendInFlight = true
        void this.deps.defaultSink('', imageIds, mode, new AbortController().signal).then((outcome) => {
          this.imageSendInFlight = false
          if (this.disposed) return
          if (outcome.kind === 'success') this.commitSend(imageIds)
          else if (outcome.text !== undefined) this.notify('error', outcome.text)
        }, (error: unknown) => {
          this.imageSendInFlight = false
          if (!this.disposed) this.notify('error', error instanceof Error ? error.message : String(error))
        })
      }
      return
    }
    // Claimed pre-gate: a claim that does not declare image acceptance never
    // submits while images are attached — one notice, everything retained.
    // Enter-time adjudication applies the same policy for unclaimed lines
    // inside the command source itself.
    const before = this.snapshot
    if (before.phase === 'claimed' && this.imageIds.length > 0 && before.claim?.images !== true) {
      this.notify('error', this.deps.commandImages.unsupportedNotice(before.claim?.token ?? before.draft))
      return
    }
    this.run(this.core.dispatch({ type: 'enter', mode }))
    const phase = this.snapshot.phase
    if (phase === 'adjudicating' || phase === 'submitting') {
      this.deps.popup?.()?.dismiss()
      this.deps.inputTriggers?.()?.track(this.snapshot.draft, 0, { tier: 'frozen' }, this.snapshot.draftRev)
    }
  }

  /**
   * Feed a draft/caret change through trigger detection (guard derived from
   * the machine phase).
   * @param draft - live draft text.
   * @param caret - caret position in draft coordinates.
   */
  track(draft: string, caret: number): void {
    this.deps.inputTriggers?.()?.track(draft, caret, { tier: guardOf(this.snapshot.phase) }, this.snapshot.draftRev)
  }

  /**
   * Keyboard arbitration while the menu is open.
   * @param key - the intercepted key.
   * @param composing - IME composition guard state.
   * @returns the menu's verdict; 'pass' when no pipeline is mounted.
   */
  arbitrate(key: ArbitrateKey, composing: boolean): ArbitrateOutcome {
    return this.deps.inputTriggers?.()?.arbitrate(key, composing) ?? 'pass'
  }

  /**
   * Steer every still-pending queued message into the running turn (the
   * empty-draft accelerated-Enter gesture). Execution belongs to the hub's
   * queue choreography; absent dep = the gesture falls back to the machine's
   * empty-draft no-op.
   */
  steerQueue(): void {
    this.deps.steerQueue?.()
  }

  /**
   * Space adjudication over the controller's hot state.
   * @returns true = a claim/insert was applied — the caller preventDefaults.
   */
  space(): boolean {
    const inputTriggers = this.deps.inputTriggers?.()
    if (inputTriggers === undefined) return false
    const consumed = inputTriggers.onSpace()
    // Machine-driven draft replacement never passes through onChange, so
    // re-track: the caret lands after the token, where detection sees
    // whitespace and closes the menu.
    if (consumed) {
      const next = this.snapshot
      inputTriggers.track(next.draft, next.draft.length, { tier: guardOf(next.phase) }, next.draftRev)
    }
    return consumed
  }

  /** Dismiss the popupSelect shell (any interaction outside the box). */
  dismissPopup(): void {
    this.deps.popup?.()?.dismiss()
  }

  /** 引用装饰词表来自控制器；每个 shell 的来源身份稳定，无控制器时使用空词表。 */
  readonly lexicon: ObservableSnapshot<ReadonlyMap<'/' | '@', readonly string[]>> = {
    getSnapshot: () => this.deps.inputTriggers?.()?.lexicon.getSnapshot() ?? EMPTY_LEXICON,
    subscribe: fn => this.deps.inputTriggers?.()?.lexicon.subscribe(fn) ?? (() => {}),
  }

  /**
   * Apply one command claim (scoped begin-command event listener body).
   * @param claim - the command claim from the pick path.
   * @param span - pick-time span snapshot.
   * @returns whether the machine accepted (phase + span CAS passed and the draft mutated).
   */
  beginCommand(claim: CommandClaim, span: TokenSpan): boolean {
    const before = this.core.state.draftRev
    this.run(this.core.dispatch({ type: 'begin-command', claim, span }))
    return this.core.state.phase === 'claimed' && this.core.state.draftRev !== before
  }

  /**
   * Apply one reference insertion (scoped insert-reference event listener body).
   * @param ref - the reference insertion from the pick path.
   * @param span - pick-time span snapshot.
   * @returns whether the machine accepted.
   */
  insertReference(ref: ReferenceInsert, span: TokenSpan): boolean {
    const before = this.core.state.draftRev
    this.run(this.core.dispatch({ type: 'insert-ref', reference: ref, span }))
    return this.core.state.draftRev !== before
  }

  /**
   * Consume one command token after business success (scoped consume-token
   * event listener body). Span guard: revision CAS then splice; bare-token
   * guard: trimmed-draft equality then clear.
   * @param guard - exact span or bare-token guard.
   * @returns whether the token was consumed.
   */
  consumeToken(guard: ConsumeTokenRequest['guard']): boolean {
    const snapshot = this.core.state
    if (guard.kind === 'span') {
      if (guard.span.draftRev !== snapshot.draftRev) return false
      const draft = snapshot.draft
      this.setDraft(draft.slice(0, guard.span.start) + draft.slice(guard.span.end))
      return true
    }
    if (snapshot.draft.trim() !== guard.token) return false
    this.setDraft('')
    return true
  }

  /**
   * Insert plain reference text over the pick-time span (scoped insert-text
   * event listener body; plain-text-reference decision, web-input-machine
   * note). Same CAS-then-splice shape as the
   * consume-token span branch: the machine sees an ordinary draft-changed
   * transaction (one undo step), no occurrence is minted — the chip look is
   * a scan-derived decoration, never state.
   * @param text - the plain reference text to splice in (e.g. `/name `).
   * @param span - pick-time span snapshot (draftRev CAS).
   * @param keepCompleting - re-track at the caret after the splice so an open
   * token (a directory pick's trailing slash) reopens the menu.
   * @returns whether the text was applied.
   */
  insertText(text: string, span: TokenSpan, keepCompleting = false): boolean {
    const snapshot = this.core.state
    if (span.draftRev !== snapshot.draftRev) return false
    const draft = snapshot.draft
    this.setDraft(draft.slice(0, span.start) + text + draft.slice(span.end))
    if (keepCompleting) {
      // Machine-driven draft replacement never passes through onChange, so
      // re-track at the caret inside the still-open token (see space()).
      const next = this.snapshot
      this.deps.inputTriggers?.()?.track(next.draft, span.start + text.length, { tier: guardOf(next.phase) }, next.draftRev)
    }
    return true
  }

  /**
   * Surface a notice from outside the machine (detached command results).
   * @param level - severity tier.
   * @param text - notice body.
   */
  notify(level: 'info' | 'error', text: string): void {
    this.noticeSeq += 1
    this.notices.set({ level, text, seq: this.noticeSeq })
  }

  // ---- wiring-layer extras (not on the frozen SessionInput face) ----

  /** Teardown: abort any in-flight attempt and stop accepting async settlements. */
  dispose(): void {
    this.disposed = true
    this.run(this.core.dispatch({ type: 'release' }))
  }

  /** Read the live machine state (guard derivation reads here). */
  get snapshot(): InputState {
    return this.state.getSnapshot()
  }

  /**
   * 包内跨会话迁移；提交中的任一端拒绝，引用身份由目标重新物化。
   * @param target - 接纳输入的目标 shell。
   * @returns 是否完成迁移；拒绝时双方保持不变。
   */
  moveDraftTo(target: SessionInputShell): boolean {
    const locked = (shell: SessionInputShell) => shell.disposed || shell.imageSendInFlight
      || guardOf(shell.snapshot.phase) === 'frozen'
    if (locked(this) || locked(target)) return false
    return this === target || transferDraft(this, target)
  }

  /**
   * 先由调用方恢复持久草稿，再绑定镜像；绑定立即同步未挂载期间收到的规范文本。
   * @param write - 会话 store 的草稿写入口。
   * @returns 仅撤回本次镜像的 disposer。
   */
  bindMirror(write: (text: string) => void): () => void {
    this.mirrorFn = write
    this.lastMirroredDraft = projectClipboard(this.snapshot)
    write(this.lastMirroredDraft)
    return () => {
      if (this.mirrorFn === write) this.mirrorFn = undefined
    }
  }

  // ---- effect executor ----

  private run(effects: readonly InputEffect[]): void {
    for (const fx of effects) this.execute(fx)
    this.publish()
  }

  private execute(fx: InputEffect): void {
    switch (fx.type) {
      case 'notice': {
        this.noticeSeq += 1
        this.notices.set({ level: fx.level, text: fx.text, seq: this.noticeSeq })
        return
      }
      case 'adjudicate': {
        this.adjudicate(fx.attempt, fx.draft)
        return
      }
      case 'begin-submit': {
        this.beginSubmit(fx.attempt, fx.claim, fx.args)
        return
      }
      case 'default-sink': {
        this.sinkSerialized(fx.attempt, fx.draft, fx.mode)
        return
      }
      default:
        return // machine-internal effects (mirror rides publish)
    }
  }

  /**
   * 提交前按来源序列化引用；缺失来源、序列化失败或取消都阻止发送，保留原草稿。
   * @param draft - 与当前 occurrence 偏移对应的展示文本。
   * @param signal - 本次提交的中止信号。
   * @param occurrences - 提交开始时截取的引用位置；异步序列化不得读取后续编辑。
   * @returns 保留普通文本的模型可见引用文本。
   */
  private async serializeDraft(draft: string, signal: AbortSignal, occurrences: readonly Occurrence[]): Promise<string> {
    if (occurrences.length === 0) return draft
    const inputTriggers = this.deps.inputTriggers?.()
    const parts = await Promise.all(occurrences.map(async (o) => {
      if (inputTriggers === undefined) throw new Error(`no serializer for reference source "${o.source}"`)
      return { offset: o.offset, length: o.length, text: await inputTriggers.serializeReference(o.source, o.ref, signal) }
    }))
    let out = ''
    let cursor = 0
    for (const part of parts) {
      out += draft.slice(cursor, part.offset) + part.text
      cursor = part.offset + part.length
    }
    return out + draft.slice(cursor)
  }

  /** 普通消息沿用同一次提交的引用序列化；失败不降级为展示名。 */
  private sinkSerialized(attempt: SubmitAttempt, draft: string, mode: InputSubmitMode): void {
    const imageIds = [...this.imageIds]
    const occurrences = attempt.occurrencesSnapshot
    if (occurrences.length === 0) {
      this.settleSubmit(attempt, this.deps.defaultSink(draft.trim(), imageIds, mode, attempt.signal), imageIds)
      return
    }
    void this.serializeDraft(draft, attempt.signal, occurrences).then(
      (text) => {
        if (this.dead(attempt)) return
        this.settleSubmit(attempt, this.deps.defaultSink(text.trim(), imageIds, mode, attempt.signal), imageIds)
      },
      (error: unknown) => {
        if (this.dead(attempt)) return
        const message = error instanceof Error ? error.message : String(error)
        this.run(this.core.dispatch({ type: 'submit-settled', attempt, ok: false, message }))
      },
    )
  }

  /** Settle one admission attempt; successful sends consume only their captured images. */
  private settleSubmit(
    attempt: SubmitAttempt,
    pending: Promise<SubmitOutcome>,
    imageIds: readonly DraftAttachmentId[] = [],
  ): void {
    pending.then(
      (outcome) => {
        if (this.dead(attempt)) return
        if (outcome.kind === 'success' && imageIds.length > 0) {
          const submitted = new Set(imageIds)
          this.imageIds = this.imageIds.filter(id => !submitted.has(id))
        }
        this.run(this.core.dispatch({
          type: 'submit-settled',
          attempt,
          ok: outcome.kind === 'success',
          outcome,
        }))
      },
      (error: unknown) => {
        if (this.dead(attempt)) return
        this.run(this.core.dispatch({
          type: 'submit-settled',
          attempt,
          ok: false,
          message: error instanceof Error ? error.message : String(error),
        }))
      },
    )
  }

  /** Enter adjudication: poll the session controller; failure = notice + draft retained (never a silent downgrade). */
  private adjudicate(attempt: SubmitAttempt, draft: string): void {
    const inputTriggers = this.deps.inputTriggers?.()
    if (inputTriggers === undefined) {
      // No pipeline mounted: the '/' line is an ordinary message.
      this.run(this.core.dispatch({ type: 'adjudicated', attempt, outcome: undefined }))
      return
    }
    inputTriggers.adjudicate(draft.trim(), attempt.signal, { images: this.imageIds.length }).then(
      (outcome: PickOutcome) => {
        if (this.dead(attempt)) return
        this.run(this.core.dispatch({ type: 'adjudicated', attempt, outcome }))
      },
      (error: unknown) => {
        if (this.dead(attempt)) return
        const message = error instanceof Error ? error.message : String(error)
        this.run(this.core.dispatch({ type: 'adjudication-failed', attempt, message }))
      },
    )
  }

  /** 命令与普通消息共用规范引用序列化；图片仍只在命令接纳后释放。 */
  private beginSubmit(attempt: SubmitAttempt, claim: CommandClaim, args: string): void {
    const imageIds = claim.images === true ? [...this.imageIds] : []
    const occurrences = attempt.occurrencesSnapshot
    Promise.resolve()
      .then(async () => {
        const images = imageIds.length > 0 ? await this.deps.commandImages.serialize(imageIds) : []
        const serializedArgs = occurrences.length > 0
          ? argsAfter(await this.serializeDraft(attempt.draftSnapshot, attempt.signal, occurrences), claim.token)
          : args
        if (this.dead(attempt)) return undefined
        return claim.submit(serializedArgs, this.deps.actx, images)
      })
      .then(
        (outcome) => {
          if (outcome === undefined || this.dead(attempt)) return
          if (outcome.kind === 'success' && imageIds.length > 0) {
            const submitted = new Set(imageIds)
            this.imageIds = this.imageIds.filter(id => !submitted.has(id))
            this.deps.commandImages.release(imageIds)
          }
          this.run(this.core.dispatch({
            type: 'submit-settled', attempt, ok: outcome.kind === 'success', outcome,
            ...(outcome.kind === 'error' && outcome.text === undefined ? { message: 'command failed' } : {}),
          }))
        },
        (error: unknown) => {
          if (this.dead(attempt)) return
          const message = error instanceof Error ? error.message : String(error)
          this.run(this.core.dispatch({ type: 'submit-settled', attempt, ok: false, message }))
        },
      )
  }

  /** Late-settlement guard: superseded attempts and disposed facades drop silently. */
  private dead(attempt: SubmitAttempt): boolean {
    return this.disposed || attempt.signal.aborted
  }

  private compose(): InputState {
    const core = this.core.state
    return { ...core, imageIds: this.imageIds, queue: this.deps.queue?.getSnapshot() ?? EMPTY_QUEUE }
  }

  private publish(): void {
    const next = this.compose()
    this.state.set(next)
    const mirroredDraft = projectClipboard(next)
    if (mirroredDraft !== this.lastMirroredDraft) {
      this.lastMirroredDraft = mirroredDraft
      this.mirrorFn?.(mirroredDraft)
    }
  }
}
