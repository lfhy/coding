/** Local node-pty terminal-process implementation for the subprocess seam. */

import { Buffer } from 'node:buffer'
import { constants } from 'node:os'
import { PassThrough } from 'node:stream'
import type { IDisposable, IPty } from 'node-pty'
import type {
  SubprocessOutcome,
  SubprocessTerminalForeground,
  SubprocessTerminalHandle,
  SubprocessTerminalSignal,
} from '@deepseek-ai/dsh-subprocess'
import type { ProcessIdentity, ProcessInspector } from './process-inspector.ts'
import { validateTerminalSize } from './terminal-size.ts'

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function signalName(number: number | undefined): NodeJS.Signals | null {
  if (number === undefined || number === 0) return null
  for (const [name, value] of Object.entries(constants.signals)) {
    if (value === number) return name as NodeJS.Signals
  }
  return null
}

/**
 * 本地终端把进程会话所有权保留在 PTY 后端之下。`terminate()` 结算后没有
 * write、resize、inspection 或 signal 仍在执行；这里无需异步操作追踪，因为
 * node-pty 写入、resize 与进程检查都在调用栈内同步完成。任何句柄操作一旦加入
 * 真正的异步步骤，就必须像远端提供方一样显式追踪并排空。
 */
export class LocalTerminalHandle implements SubprocessTerminalHandle {
  readonly pid: number
  readonly output = new PassThrough()
  readonly done: Promise<SubprocessOutcome>

  private readonly outcome = Promise.withResolvers<SubprocessOutcome>()
  private readonly dataDisposable: IDisposable
  private readonly exitDisposable: IDisposable
  private cleanup: Promise<void> | undefined
  private exited = false
  private stopping = false
  private trackedDescendants: ProcessIdentity[] = []
  /** 启动 shell 的精确身份；根 pid 不再携带该身份后，扫描不再接纳新成员。 */
  private readonly rootIdentity: ProcessIdentity | undefined

  /**
   * @param terminal - 已分配的 node-pty 进程。
   * @param inspector - 平台进程与会话操作。
   * @param graceMs - TERM 到 KILL 以及退出等待的宽限毫秒数。
   * @param platform - 宿主平台；默认使用当前平台，测试可显式注入。
   */
  constructor(
    private readonly terminal: IPty,
    private readonly inspector: ProcessInspector,
    private readonly graceMs: number,
    private readonly platform: NodeJS.Platform = process.platform,
  ) {
    this.pid = terminal.pid
    this.rootIdentity = inspector.processTree(this.pid).find(member => member.pid === this.pid)
    this.done = this.outcome.promise
    this.dataDisposable = terminal.onData((data) => { this.output.write(Buffer.from(data, 'utf8')) })
    this.exitDisposable = terminal.onExit(({ exitCode, signal: exitSignal }) => {
      if (this.exited) return
      this.exited = true
      this.output.end()
      this.outcome.resolve({
        exitCode: exitSignal === undefined || exitSignal === 0 ? exitCode : null,
        signal: signalName(exitSignal),
      })
    })
  }

  /** 终端退出或进入终止流程后，所有普通控制操作都必须失败关闭。 */
  private isUnavailable(): boolean { return this.exited || this.stopping }

  // node-pty 同步写入；seam 为远端传输保留 Promise 形状。
  // oxlint-disable-next-line typescript/require-await -- 保留异步提供方契约的拒绝语义。
  async write(data: string): Promise<void> {
    if (this.isUnavailable()) throw new Error('terminal process has exited')
    this.terminal.write(data)
  }

  // node-pty 同步 resize；seam 为远端传输保留 Promise 形状。
  // oxlint-disable-next-line typescript/require-await -- 保留异步提供方契约的拒绝语义。
  async resize(cols: number, rows: number): Promise<void> {
    if (this.isUnavailable()) throw new Error('terminal process has exited')
    validateTerminalSize(cols, rows)
    this.terminal.resize(cols, rows)
  }

  // 本地检查同步完成；seam 为远端传输保留 Promise 形状。
  // oxlint-disable-next-line typescript/require-await -- 保留异步提供方契约的拒绝语义。
  async inspectForeground(): Promise<SubprocessTerminalForeground | undefined> {
    if (this.isUnavailable()) return undefined
    this.descendants()
    const processGroupId = this.inspector.foregroundPgid(this.pid)
    if (processGroupId === undefined) return undefined
    return {
      processGroupId,
      inputWaiting: this.inspector.isStdinWaiting(processGroupId, this.pid),
    }
  }

  async signalForeground(signal: SubprocessTerminalSignal): Promise<number> {
    if (this.isUnavailable()) throw new Error('terminal process has exited')
    const foreground = await this.inspectForeground()
    if (this.isUnavailable()) throw new Error('terminal process has exited')
    if (foreground === undefined) {
      throw new Error(`cannot resolve foreground process group for terminal ${this.pid}`)
    }
    if (signal === 'SIGKILL' && foreground.processGroupId === this.pid) {
      throw new Error('refusing to SIGKILL the terminal shell; terminate the terminal session instead')
    }
    if (this.platform === 'win32') {
      if (signal === 'SIGINT') {
        // Windows 没有进程组信号；conhost 会把 `\x03` 输入转成附属进程共享的
        // CTRL_C 事件。node-pty 的 signal kill 在 Windows 会抛错，因此这里不调用
        // inspector 的信号路径。
        this.terminal.write('\x03')
        return foreground.processGroupId
      }
      if (signal === 'SIGTSTP' || signal === 'SIGHUP') {
        throw new Error(`signal ${signal} is unsupported on Windows; only SIGINT, SIGTERM, and SIGKILL are available`)
      }
    }
    this.inspector.signalGroup(foreground.processGroupId, signal)
    return foreground.processGroupId
  }

  terminate(): Promise<void> {
    if (this.cleanup !== undefined) return this.cleanup
    this.stopping = true
    const cleanup = this.closeOnce()
    this.cleanup = cleanup
    void cleanup.catch(() => { this.cleanup = undefined })
    return cleanup
  }

  /**
   * 在 Node `exit` 事件中同步强杀仍可观察的会话。该路径不声称已经完全停稳，
   * 也不替代须等待的 {@link terminate}。
   */
  terminateForHostExit(): void {
    this.stopping = true
    this.forceStopDescendants()
    this.forceStopShell()
    this.forceStopDescendants()
  }

  private forceStopShell(): void {
    if (this.exited) return
    if (this.rootIdentity !== undefined) {
      try {
        this.inspector.signalProcess(this.rootIdentity, 'SIGKILL')
      } catch (_rootExitedDuringHostExit) {
        // Exact identity signalling contains both exit races and PID reuse.
      }
      return
    }
    try {
      this.terminal.kill('SIGKILL')
    } catch (_unidentifiedShellExitedDuringHostExit) {
      // Without a captured identity, node-pty is the only root kill primitive.
    }
  }

  private survivors(members: ProcessIdentity[]): ProcessIdentity[] {
    return members.filter(member => this.inspector.isAlive(member))
  }

  private descendants(): ProcessIdentity[] {
    // Adopt newly scanned members only while the numeric root pid provably
    // still carries the spawned shell's start identity: after the shell dies,
    // a recycled pid's tree and session must not donate an unrelated
    // process's children to this session's signalling. Already-adopted
    // members keep their own start identities, which every signal rechecks.
    const tree = this.inspector.processTree(this.pid)
    const root = tree.find(member => member.pid === this.pid)
    const rootVerified = this.rootIdentity !== undefined
      && root !== undefined
      && root.started === this.rootIdentity.started
    this.trackedDescendants = this.survivors(this.unionMembers(
      this.trackedDescendants,
      ...rootVerified ? [tree, this.inspector.processSession(this.pid)] : [],
    ).filter(member => member.pid !== this.pid))
    return this.trackedDescendants
  }

  private async waitForMembers(members: ProcessIdentity[]): Promise<ProcessIdentity[]> {
    const until = Date.now() + this.graceMs
    let survivors = this.survivors(members)
    while (survivors.length > 0 && Date.now() < until) {
      await delay(Math.min(25, Math.max(1, until - Date.now())))
      survivors = this.survivors(members)
    }
    return survivors
  }

  private signalMembers(members: ProcessIdentity[], signal: 'SIGTERM' | 'SIGKILL'): void {
    for (const member of members) {
      try {
        this.inspector.signalProcess(member, signal)
      } catch (_alreadyExitedDuringSignal) {
        // The exact process identity is rechecked; a same-tick exit is success.
      }
    }
  }

  private forceStopDescendants(): void {
    let members = this.trackedDescendants
    try {
      members = this.descendants()
    } catch (_processTableUnavailableDuringHostExit) {
      // Preserve already-captured identities when a final process-table scan fails.
    }
    this.signalMembers(members, 'SIGKILL')
  }

  private unionMembers(...groups: ProcessIdentity[][]): ProcessIdentity[] {
    const members: ProcessIdentity[] = []
    const seen = new Set<string>()
    for (const group of groups) {
      for (const member of group) {
        const key = `${member.pid}:${member.started}`
        if (seen.has(key)) continue
        seen.add(key)
        members.push(member)
      }
    }
    return members
  }

  private async stopDescendants(): Promise<ProcessIdentity[]> {
    const captured = this.descendants()
    this.signalMembers(captured, 'SIGTERM')
    const capturedSurvivors = await this.waitForMembers(captured)
    const members = this.unionMembers(capturedSurvivors, this.descendants())
    this.signalMembers(members, 'SIGKILL')
    const survivors = await this.waitForMembers(members)
    return this.survivors(this.unionMembers(survivors, this.descendants()))
  }

  private async stopShell(): Promise<void> {
    if (this.platform === 'win32') {
      await this.stopShellWindows()
      return
    }
    if (!this.exited) {
      try {
        this.terminal.kill('SIGTERM')
      } catch (_topLevelAlreadyExitedDuringTerm) {
        // The exit callback is authoritative.
      }
      await Promise.race([this.done.then(() => undefined), delay(this.graceMs)])
    }
    if (!this.exited) {
      try {
        this.terminal.kill('SIGKILL')
      } catch (_topLevelAlreadyExitedDuringKill) {
        // The exit callback is authoritative.
      }
      await Promise.race([this.done.then(() => undefined), delay(this.graceMs)])
    }
    if (!this.exited) throw new Error(`terminal cleanup failed; surviving pid: ${this.pid}`)
  }

  private async stopShellWindows(): Promise<void> {
    // node-pty's Windows kill(signal) throws ("Signals not supported on
    // windows"), and its bare kill() delegates to a console-list agent that
    // fails when the parent has no console. taskkill tree escalation is the
    // teardown path, fenced on the shell's start identity like every
    // descendant; a root identity miss falls back to the bare kill. taskkill
    // termination also does not reliably fire node-pty's exit notification
    // (the same console-list agent), so the tiers verify the shell's absence
    // through the inspector instead of waiting on `done` alone.
    const shellGone = (): boolean =>
      this.exited || (this.rootIdentity !== undefined && !this.inspector.isAlive(this.rootIdentity))
    if (!shellGone() && this.rootIdentity !== undefined) {
      this.inspector.signalProcess(this.rootIdentity, 'SIGTERM')
      await this.waitForWindowsShellExit()
    }
    if (!shellGone() && this.rootIdentity === undefined) {
      try {
        this.terminal.kill()
      } catch (_topLevelAlreadyExitedDuringKill) {
        // The exit callback is authoritative.
      }
      await Promise.race([this.done.then(() => undefined), delay(this.graceMs)])
    }
    if (!shellGone() && this.rootIdentity !== undefined) {
      this.inspector.signalProcess(this.rootIdentity, 'SIGKILL')
      await this.waitForWindowsShellExit()
    }
    if (!shellGone()) throw new Error(`terminal cleanup failed; surviving pid: ${this.pid}`)
  }

  private async waitForWindowsShellExit(): Promise<void> {
    const until = Date.now() + this.graceMs
    while (!this.exited && Date.now() < until) {
      if (this.rootIdentity !== undefined && !this.inspector.isAlive(this.rootIdentity)) return
      await delay(Math.min(25, Math.max(1, until - Date.now())))
    }
  }

  private async closeOnce(): Promise<void> {
    let survivors = await this.stopDescendants()
    if (survivors.length > 0) {
      throw new Error(`terminal cleanup failed; surviving pids: ${survivors.map(member => member.pid).join(', ')}`)
    }
    await this.stopShell()
    survivors = await this.stopDescendants()
    if (survivors.length > 0) {
      throw new Error(`terminal cleanup failed; surviving pids: ${survivors.map(member => member.pid).join(', ')}`)
    }
    this.settleExitIfGone()
    this.dataDisposable.dispose()
    this.exitDisposable.dispose()
  }

  private settleExitIfGone(): void {
    // An externally taskkilled Windows shell may never fire node-pty's exit
    // notification (its console-list agent fails without a parent console),
    // which would leave `done` — and every consumer awaiting it — unsettled
    // forever. Teardown has just verified the shell's absence through the
    // inspector, so a missing exit event is itself the outcome.
    if (this.platform !== 'win32') return
    if (this.exited) return
    /* v8 ignore next -- stopShellWindows() verified the shell is gone or threw;
       the identity re-check is a defensive fence for a future caller. */
    if (this.rootIdentity !== undefined && this.inspector.isAlive(this.rootIdentity)) return
    this.exited = true
    this.output.end()
    this.outcome.resolve({ exitCode: null, signal: null })
  }
}
