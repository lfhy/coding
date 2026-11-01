/** 第三方 ego-browser heredoc 的受限模板：所有脚本由 Host 常量拼装，不执行模型提供的 JS。 */
import { spaceNameForSession } from './session-space.ts'
import type { SessionId } from 'coding-session/types'

const SENTINEL = '@@DSH_RESULT@@'

function encode(value: unknown): string { return JSON.stringify(value) }
function result(expression: string): string {
  return `console.log('${SENTINEL}' + JSON.stringify(${expression}))\n`
}

/** 本次执行重新选中对应会话的任务空间和该空间实际登记的活跃标签。 */
export function scriptFor(name: string, args: Record<string, unknown>, sessionId: SessionId): string {
  const space = spaceNameForSession(sessionId)
  const enter = `await taskSpaces.useOrCreate(${encode(space)})\n`
  const choose = 'const __tabs = await browser.listTabs()\n' +
    'const __active = __tabs.find(t => t.active) || __tabs[0]\n' +
    'if (__active) await browser.switchTab(__active.targetId)\n'
  switch (name) {
    case 'ego_navigate':
      return enter + choose +
        `const __match = __tabs.find(t => t.url === ${encode(args.url)})\n` +
        'if (__match) await browser.switchTab(__match.targetId)\n' +
        `else if (__active) await page.goto(${encode(args.url)})\n` +
        `else await ego.createTab(${encode(args.url)})\n` +
        result('{ ok: true, page: await page.info(), reused: !!__match }')
    case 'ego_snapshot':
      return enter + choose + 'const __snap = await page.snapshotRaw()\n' +
        result('{ ok: true, text: (__snap.content || "").slice(0, 24000) }')
    case 'ego_page_info':
      return enter + choose + result('{ ok: true, page: await page.info() }')
    case 'ego_tabs':
      return enter + result('{ ok: true, tabs: await browser.listTabs() }')
    case 'ego_click':
      return enter + choose + `await page.locator(${encode(args.selector)}).click()\n` + result('{ ok: true, page: await page.info() }')
    case 'ego_fill':
      return enter + choose + `await page.locator(${encode(args.selector)}).fill(${encode(args.text)})\n` +
        result('{ ok: true, page: await page.info() }')
    case 'ego_scroll':
      return enter + choose + `await page.mouse.wheel(${encode(args.deltaX ?? 0)}, ${encode(args.deltaY ?? 0)})\n` +
        result('{ ok: true, page: await page.info() }')
    case 'ego_wait':
      return enter + choose + `await page.waitForTimeout(${encode(args.ms)})\n` + result(`{ ok: true, waitedMs: ${encode(args.ms)} }`)
    case 'ego_wait_for_selector':
      return enter + choose +
        `await page.waitForSelector(${encode(args.selector)}, { state: ${encode(args.state ?? 'visible')}, timeout: ${encode(args.timeout ?? 10000)} })\n` +
        result(`{ ok: true, selector: ${encode(args.selector)}, waited: true }`)
    case 'ego_wait_for_url':
      return enter + choose +
        `await page.waitForURL(${encode(args.pattern)}, { timeout: ${encode(args.timeout ?? 10000)} })\n` +
        result('{ ok: true, reached: true, url: await page.url() }')
    case 'ego_key':
      return enter + choose + (typeof args.text === 'string' && args.text !== ''
        ? `await page.keyboard.type(${encode(args.text)})\n` : `await page.keyboard.press(${encode(args.key)})\n`) +
        result('{ ok: true }')
    case 'ego_hover':
      return enter + choose + `await page.locator(${encode(args.selector)}).hover()\n` + result('{ ok: true }')
    case 'ego_read_element': {
      const locator = `page.locator(${encode(args.selector)})`
      const operation: Record<string, string> = {
        text: `await ${locator}.textContent()`, html: `await ${locator}.innerHTML()`,
        value: `await ${locator}.inputValue()`,
        attribute: `await ${locator}.getAttribute(${encode(args.attribute)})`,
        visible: `await ${locator}.isVisible()`, enabled: `await ${locator}.isEnabled()`,
        count: `await ${locator}.count()`,
      }
      return enter + choose + `const __value = ${operation[typeof args.what === 'string' ? args.what : 'text']}\n` +
        result(`{ ok: true, what: ${encode(args.what ?? 'text')}, value: __value }`)
    }
    case 'ego_select':
      return enter + choose + `const __selected = await page.locator(${encode(args.selector)}).selectOption(${encode(args.value)})\n` +
        result('{ ok: true, values: __selected }')
    case 'ego_drag':
      return enter + choose + `await page.locator(${encode(args.from)}).dragTo(page.locator(${encode(args.to)}))\n` +
        result('{ ok: true }')
    case 'ego_check':
      return enter + choose + `await page.locator(${encode(args.selector)}).${args.checked === false ? 'uncheck' : 'check'}()\n` +
        result(`{ ok: true, checked: ${args.checked !== false} }`)
    case 'ego_captcha':
      return enter + choose +
        `const __probe = await page.evaluate(${encode('(() => { const el = document.querySelector(\'iframe[src*="recaptcha"],.g-recaptcha,.h-captcha,iframe[src*="hcaptcha"],.cf-turnstile,#captcha\'); return { detected: !!el, kind: el ? \'captcha\' : null } })()')})\n` +
        result('{ ok: true, detected: __probe.detected, kind: __probe.kind }')
    case 'ego_screenshot':
      // 临时截图名由运行时生成，模型不能经脚本参数指定任意执行路径。
      return enter + choose + 'const path = await page.screenshot()\n' + result('{ ok: true, path }')
    default:
      throw new Error('unsupported browser tool')
  }
}

/** 防止上游输出包含未标记的诊断或 CLI 横幅。 */
export function parseScriptResult(stdout: string): unknown {
  const line = stdout.split(/\r?\n/u).findLast(entry => entry.startsWith(SENTINEL))
  if (!line) throw new Error('browser operation did not return a result')
  try {
    const value: unknown = JSON.parse(line.slice(SENTINEL.length))
    if (!value || typeof value !== 'object' || !('ok' in value)) throw new Error('invalid browser result')
    return value
  } catch { throw new Error('browser operation returned invalid data') }
}
