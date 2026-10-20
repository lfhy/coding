/** 模型浏览器输入的引用复核与 CDP 操作；调用方保有会话队列、审批目标和页面生命周期。 */
import type { BrowserCapture, BrowserCommand, BrowserObservation } from 'coding-browser'
import type { Owner, Tab } from './browser-guest-state.ts'
import type { TargetOutcome } from './browser-guest-snapshot.ts'

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
  fail(message: string): never
}

/**
 * 操作当前页面；输入前后复核身份，按下后导航必须关闭会话以收敛按键状态。
 * @param operation - 单次操作绑定的页面及生命周期回调。
 * @returns 本次输入的指针与可选原生反馈；失败不会重试任何输入。
 */
export async function performModelOperation(operation: ModelOperation): Promise<{
  cursor: BrowserObservation['cursor']
  feedback: Promise<void> | undefined
}> {
  const { command, owner, tab, evaluate, requireTarget, pointers } = operation
  let cursor: BrowserObservation['cursor'] = null
  let feedback: Promise<void> | undefined
  switch (command.kind) {
    case 'navigate': await operation.navigate(command.url); break
    case 'click':
    case 'fill': {
      if (command.revision !== tab.revision || !tab.capture) operation.fail('stale browser element revision')
      const latest = tab.capture as BrowserCapture | undefined
      if (latest?.observation.revision !== command.revision) operation.fail('stale browser element revision')
      const documentEpoch = tab.navigation
      const escaped = JSON.stringify(command.ref)
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
        if (${command.kind === 'fill'} && (el.disabled || el.readOnly ||
          (!('value' in el) && !el.isContentEditable))) return { reason: 'element_not_editable' };
        const style = getComputedStyle(el), box = el.getBoundingClientRect();
        if (!box.width || !box.height || style.display === 'none' || style.visibility === 'hidden' ||
          style.pointerEvents === 'none') return { reason: 'element_hidden' };
        if (ref.identity.disabled || el.matches(':disabled') ||
          el.closest('[aria-disabled="true"], [inert]')) return { reason: 'element_disabled' };
        return globalThis.__dshGuestHit(el); })()`
      const box = requireTarget(await evaluate<TargetOutcome>(tab, targetExpression), command.ref, owner)
      operation.assertStable(documentEpoch)
      const current = tab.capture as BrowserCapture | undefined
      if (current?.observation.revision !== command.revision) operation.fail('browser element changed before input')
      await operation.moveCursor(box.x, box.y)
      // 目标移动不自动过期；复核后的命中点才是输入落点。
      const verified = requireTarget(await evaluate<TargetOutcome>(tab, targetExpression), command.ref, owner)
      operation.assertStable(documentEpoch)
      operation.assertTarget()
      const movedCapture = tab.capture as BrowserCapture | undefined
      if (movedCapture?.observation.revision !== command.revision) operation.fail('browser element changed during cursor movement')
      const { x, y } = verified
      cursor = { x, y, kind: command.kind, at: Date.now() }
      operation.mutate()
      await tab.view.webContents.debugger.sendCommand('Input.dispatchMouseEvent', {
        type: 'mousePressed', x, y, button: 'left', clickCount: 1,
      })
      try { operation.assertStable(documentEpoch); operation.assertTarget() }
      catch (error) { operation.destroy(); throw error }
      await tab.view.webContents.debugger.sendCommand('Input.dispatchMouseEvent', {
        type: 'mouseReleased', x, y, button: 'left', clickCount: 1,
      })
      if (command.kind === 'fill') {
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
        if (!focused || current?.observation.revision !== command.revision) operation.fail('browser element changed before fill')
        await tab.view.webContents.debugger.sendCommand('Input.insertText', { text: command.text })
      }
      feedback = operation.feedback(x, y, command.kind)
      pointers.set(tab.id, { x, y })
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
    case 'snapshot': case 'screenshot': break
    default: { const never: never = command; throw new Error(`unknown browser command: ${String(never)}`) }
  }
  return { cursor, feedback }
}
