/** 模型浏览器输入的引用复核与 CDP 操作；调用方保有会话队列、审批目标和页面生命周期。 */
import type { BrowserCapture, BrowserCommand, BrowserObservation, BrowserStep, BrowserStepResult } from 'coding-browser'
import { MAX_ACT_STEPS } from 'coding-browser-electron/protocol'
import type { Owner, Tab } from './browser-guest-state.ts'
import { GuestError } from './browser-guest-state.ts'
import type { TargetOutcome } from './browser-guest-snapshot.ts'

const MAX_STEP_REASON_CHARS = 200

interface ModelOperation {
  command: Exclude<BrowserCommand, { kind: 'close' }>
  owner: Owner
  tab: Tab
  evaluate: <T>(tab: Tab, expression: string) => Promise<T>
  requireTarget: (outcome: TargetOutcome, ref: string, owner: Owner) => { x: number; y: number }
  assertStable(navigation: number): void
  assertTarget(): void
  destroy(): void
  moveCursor(x: number, y: number): Promise<void>
  feedback(x: number, y: number, kind: 'click' | 'fill' | 'scroll'): Promise<void> | undefined
  pointers: Map<string, { x: number; y: number }>
  mutate(): void
  navigate(url: string): Promise<void>
  setViewport(width: number, height: number): Promise<void>
  fail(message: string): never
}

/** 一次模型操作的实际结果；批量动作额外给出已尝试步骤的成败。 */
export interface ModelOperationOutcome {
  cursor: BrowserObservation['cursor']
  feedback: Promise<void> | undefined
  steps?: BrowserStepResult[]
}

/** 批次内一步的失败原因：去掉控制字符并限长，避免页面文本撑大结果。 */
function stepReason(error: Error): string {
  const message = error.message.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim()
  return (message === '' ? 'the element could not be used' : message).slice(0, MAX_STEP_REASON_CHARS)
}

/**
 * 在已观测的页面上执行一步点击或填写；输入前后复核引用、文档身份与审批目标。
 * 引用失效、属性变化、不可编辑或不可见都以过期引用拒绝，且不重试任何输入。
 * @param operation - 本次操作绑定的页面及生命周期回调。
 * @param revision - 模型给出的观测修订版；每步都以同一个修订版复核。
 * @param step - 要执行的一步元素操作。
 * @returns 这一步的指针位置与可选原生反馈。
 */
async function performElementStep(operation: ModelOperation, revision: number, step: BrowserStep): Promise<{
  cursor: BrowserObservation['cursor']
  feedback: Promise<void> | undefined
}> {
  const { tab, evaluate, requireTarget, pointers } = operation
  if (revision !== tab.revision || !tab.capture) operation.fail('stale browser element revision')
  const latest = tab.capture as BrowserCapture | undefined
  if (latest?.observation.revision !== revision) operation.fail('stale browser element revision')
  const documentEpoch = tab.navigation
  const escaped = JSON.stringify(step.ref)
  // 引用只比较输入含义；展示性属性和旁支文本更新由最终命中检测兜底。
  const targetExpression = `(() => { const ref = globalThis.__dshGuestRefs?.get(${escaped}); const el = ref?.el;
    if (!el || !el.isConnected) return { reason: 'element_left_document' };
    if (ref.form !== (el.form ?? null)) return { reason: 'element_form_changed' };
    const path = globalThis.__dshGuestPath(el);
    if (path.length !== ref.path.length || path.some((part, i) =>
      part.node !== ref.path[i].node || part.parent !== ref.path[i].parent ||
      JSON.stringify(part.attributes) !== JSON.stringify(ref.path[i].attributes))) {
      return { reason: 'ancestors_changed' };
    }
    if (JSON.stringify(ref.identity) !== JSON.stringify(globalThis.__dshGuestIdentity(el))) {
      return { reason: 'element_changed' };
    }
    if (${step.kind === 'fill'} && (el.disabled || el.readOnly ||
      (!('value' in el) && !el.isContentEditable))) return { reason: 'element_not_editable' };
    const style = getComputedStyle(el), box = el.getBoundingClientRect();
    if (!box.width || !box.height || style.display === 'none' || style.visibility === 'hidden' ||
      style.pointerEvents === 'none') return { reason: 'element_hidden' };
    if (ref.identity.disabled || el.matches(':disabled') ||
      el.closest('[aria-disabled="true"], [inert]')) return { reason: 'element_disabled' };
    return globalThis.__dshGuestHit(el); })()`
  const box = requireTarget(await evaluate<TargetOutcome>(tab, targetExpression), step.ref, operation.owner)
  operation.assertStable(documentEpoch)
  const current = tab.capture as BrowserCapture | undefined
  if (current?.observation.revision !== revision) operation.fail('browser element changed before input')
  await operation.moveCursor(box.x, box.y)
  // 目标移动不自动过期；复核后的命中点才是输入落点。
  const verified = requireTarget(await evaluate<TargetOutcome>(tab, targetExpression), step.ref, operation.owner)
  operation.assertStable(documentEpoch)
  operation.assertTarget()
  const movedCapture = tab.capture as BrowserCapture | undefined
  if (movedCapture?.observation.revision !== revision) operation.fail('browser element changed during cursor movement')
  const { x, y } = verified
  const cursor: BrowserObservation['cursor'] = { x, y, kind: step.kind, at: Date.now() }
  operation.mutate()
  await tab.view.webContents.debugger.sendCommand('Input.dispatchMouseEvent', {
    type: 'mousePressed', x, y, button: 'left', clickCount: 1,
  })
  try { operation.assertStable(documentEpoch); operation.assertTarget() }
  catch (error) { operation.destroy(); throw error }
  await tab.view.webContents.debugger.sendCommand('Input.dispatchMouseEvent', {
    type: 'mouseReleased', x, y, button: 'left', clickCount: 1,
  })
  if (step.kind === 'fill') {
    operation.assertStable(documentEpoch)
    const focused = await evaluate<boolean>(tab, `(() => { const ref = globalThis.__dshGuestRefs?.get(${escaped}); const el = ref?.el;
      if (!el || !el.isConnected || ref.form !== (el.form ?? null)) return false;
      const path = globalThis.__dshGuestPath(el);
      if (path.length !== ref.path.length || path.some((part, i) =>
        part.node !== ref.path[i].node || part.parent !== ref.path[i].parent ||
        JSON.stringify(part.attributes) !== JSON.stringify(ref.path[i].attributes)) ||
        JSON.stringify(ref.identity) !== JSON.stringify(globalThis.__dshGuestIdentity(el)) ||
        el.disabled || el.readOnly || (!('value' in el) && !el.isContentEditable)) return false;
      el.focus(); if (el.getRootNode().activeElement !== el) return false;
      if (el.isContentEditable) el.textContent = '';
      else { const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value')?.set;
        if (setter) setter.call(el, ''); else el.value = ''; }
      el.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`)
    operation.assertStable(documentEpoch)
    const current = tab.capture as BrowserCapture | undefined
    if (!focused || current?.observation.revision !== revision) operation.fail('browser element changed before fill')
    await tab.view.webContents.debugger.sendCommand('Input.insertText', { text: step.text })
  }
  const feedback = operation.feedback(x, y, step.kind)
  pointers.set(tab.id, { x, y })
  return { cursor, feedback }
}

/**
 * 校验批次修订版是否就是当前观测；不匹配时在动手前拒绝整批，而不是返回空结果。
 * 放在独立函数里，避免把 `Tab.capture` 的收窄带进随后每一步都会重新读取它的循环。
 * @param operation - 本次操作绑定的页面。
 * @param revision - 模型给出的观测修订版。
 * @returns 修订版有效时无返回值。
 */
function assertBatchRevision(operation: ModelOperation, revision: number): void {
  const capture = operation.tab.capture
  if (revision !== operation.tab.revision || capture === undefined ||
    capture.observation.revision !== revision) operation.fail('stale browser element revision')
}

/**
 * 操作当前页面；输入前后复核身份，按下后导航必须关闭会话以收敛按键状态。
 * 批量动作在同一个观测修订版上顺序执行，页面导航或某步失败即停止，未执行的步骤不出现在结果里。
 * @param operation - 单次操作绑定的页面及生命周期回调。
 * @returns 本次输入的指针、可选原生反馈与批量步骤结果；失败不会重试任何输入。
 */
export async function performModelOperation(operation: ModelOperation): Promise<ModelOperationOutcome> {
  const { command, owner, tab, evaluate, pointers } = operation
  let cursor: BrowserObservation['cursor'] = null
  let feedback: Promise<void> | undefined
  let steps: BrowserStepResult[] | undefined
  switch (command.kind) {
    case 'navigate': await operation.navigate(command.url); break
    case 'click':
    case 'fill': {
      const outcome = await performElementStep(operation, command.revision, command)
      cursor = outcome.cursor
      feedback = outcome.feedback
      break
    }
    case 'act': {
      // 整批共用一个修订版；页面导航后旧引用与审批目标一起失效，余下步骤不再执行。
      assertBatchRevision(operation, command.revision)
      const epoch = tab.navigation
      steps = []
      for (const step of command.steps) {
        if (steps.length >= MAX_ACT_STEPS) break
        // 导航会撤销当前观测；每一步重新读取，避免把输入落到已经失效的文档上。
        const current = tab.capture
        if (tab.navigation !== epoch || current === undefined || current.observation.revision !== command.revision) break
        try {
          const outcome = await performElementStep(operation, command.revision, step)
          cursor = outcome.cursor
          feedback = outcome.feedback ?? feedback
          steps.push({ kind: step.kind, ok: true })
        } catch (error) {
          // 只有元素层的拒绝（过期引用）能成为步骤结果；页面级不稳定与不可用继续向上抛出。
          if (!(error instanceof GuestError) || error.code !== 'BROWSER_STALE_REF') throw error
          steps.push({ kind: step.kind, ok: false, reason: stepReason(error) })
          break
        }
        // 点击可能提交表单；导航事件会在这里清除截图，使下一步在复核阶段停止。
        if (step.kind === 'click' && tab.navigation !== epoch) break
      }
      break
    }
    case 'scroll': {
      const pixels = Math.min(Math.max(command.pixels, 0), owner.viewport.height)
      const epoch = tab.navigation
      const pointer = pointers.get(tab.id) ?? {
        x: Math.floor(owner.viewport.width / 2), y: Math.floor(owner.viewport.height / 2),
      }
      const { x, y } = pointer
      operation.assertStable(epoch)
      operation.assertTarget()
      operation.mutate()
      await evaluate(tab, 'true')
      operation.assertStable(epoch)
      operation.assertTarget()
      await tab.view.webContents.debugger.sendCommand('Input.dispatchMouseEvent', {
        type: 'mouseWheel', x, y, deltaX: 0, deltaY: (command.direction === 'down' ? 1 : -1) * pixels,
      })
      // 隐藏页面不能依赖 requestAnimationFrame；等待异步滚轮合成后再观测。
      await new Promise<void>(resolve => setTimeout(resolve, 100))
      operation.assertStable(epoch)
      pointers.set(tab.id, { x, y })
      feedback = operation.feedback(x, y, 'scroll')
      cursor = { x, y, kind: 'scroll', at: Date.now() }
      break
    }
    case 'viewport': await operation.setViewport(command.width, command.height); break
    case 'snapshot': case 'screenshot': break
    default: { const never: never = command; throw new Error(`unknown browser command: ${String(never)}`) }
  }
  return steps === undefined ? { cursor, feedback } : { cursor, feedback, steps }
}
