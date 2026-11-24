/**
 * 页面视口的设备模拟：把当前页固定成给定的 CSS 视口（可带移动端语义），
 * 或清除覆盖回到浏览器窗口尺寸。脚本只由本模块常量拼装，不执行模型提供的 JS。
 * @module coding-browser-ego-host/viewport
 */

const SENTINEL = '@@DSH_RESULT@@'

/** 请求固定视口或清除覆盖。 */
export type ViewportRequest =
  | {
    readonly kind: 'emulate'
    /** CSS 像素宽度，与 `window.innerWidth` 同一口径。 */
    readonly width: number
    /** CSS 像素高度。 */
    readonly height: number
    /** 是否启用移动端设备度量（触摸与移动端视口语义）。 */
    readonly mobile: boolean
    /** 设备像素比；只影响渲染精度与 `window.devicePixelRatio`。 */
    readonly deviceScaleFactor: number
  }
  | { readonly kind: 'reset' }

/** 设置后从页面自身读回的实测视口。 */
export interface ViewportMeasurement {
  readonly width: number
  readonly height: number
  readonly devicePixelRatio: number
}

/** 一次视口调整的结果：成功给出实测尺寸，失败给出可操作的原因。 */
export type ViewportOutcome =
  | ({ readonly ok: true } & ViewportMeasurement)
  | { readonly ok: false; readonly reason: string }

/** 窄于 200px 的视口没有布局意义，且会撞上 Chromium 的采集下限。 */
const MIN_VIEWPORT_WIDTH = 200
/** 与上游设置项 `viewportWidth` 的上限一致。 */
const MAX_VIEWPORT_WIDTH = 3840
/** 低于 200px 的高度看不到任何整块内容。 */
const MIN_VIEWPORT_HEIGHT = 200
/** 与上游设置项 `viewportHeight` 的上限一致。 */
const MAX_VIEWPORT_HEIGHT = 2160
/** 小于 0.5 的像素比会明显丢像素。 */
const MIN_DEVICE_SCALE_FACTOR = 0.5
/** 与上游设置项 `deviceScaleFactor` 的上限保持一致。 */
const MAX_DEVICE_SCALE_FACTOR = 3

function integer(value: unknown, min: number, max: number, field: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${field} must be an integer between ${min} and ${max}`)
  }
  return value
}

/**
 * 把模型给的视口参数收敛成一次明确请求。
 *
 * `reset` 与尺寸字段互斥：同时给出时无法判断调用方要清除还是设置，
 * 因此直接报错，而不是按其中一边猜测。
 * @param input - 模型传入的参数载荷。
 * @returns 已校验的请求。
 * @throws Error 参数缺失、越界或互相矛盾时抛出面向模型的说明。
 */
export function viewportRequest(input: Record<string, unknown>): ViewportRequest {
  const reset = input.reset
  if (reset !== undefined && typeof reset !== 'boolean') throw new Error('reset must be a boolean')
  const hasSize = input.width !== undefined || input.height !== undefined
  if (reset === true) {
    if (hasSize) throw new Error('reset cannot be combined with width or height')
    return { kind: 'reset' }
  }
  if (input.width === undefined && input.height === undefined) {
    throw new Error('width and height are required; pass reset: true to clear an earlier override')
  }
  const width = integer(input.width, MIN_VIEWPORT_WIDTH, MAX_VIEWPORT_WIDTH, 'width')
  const height = integer(input.height, MIN_VIEWPORT_HEIGHT, MAX_VIEWPORT_HEIGHT, 'height')
  const mobile = input.mobile
  if (mobile !== undefined && typeof mobile !== 'boolean') throw new Error('mobile must be a boolean')
  const scale = input.deviceScaleFactor
  if (scale !== undefined && (typeof scale !== 'number' || !Number.isFinite(scale)
    || scale < MIN_DEVICE_SCALE_FACTOR || scale > MAX_DEVICE_SCALE_FACTOR)) {
    throw new Error(`deviceScaleFactor must be a number between ${MIN_DEVICE_SCALE_FACTOR} and ${MAX_DEVICE_SCALE_FACTOR}`)
  }
  return { kind: 'emulate', width, height, mobile: mobile === true,
    deviceScaleFactor: scale === undefined ? 1 : scale }
}

/**
 * 生成一次视口调整脚本。
 *
 * 脚本先进入会话自己的任务空间并选中活动页，再设置或清除 CDP 设备度量，
 * 最后读回页面自身的 `innerWidth`／`innerHeight`／`devicePixelRatio`：
 * 只有读回值才反映实际生效的视口，模型据此判断能不能用当前尺寸看布局。
 * 读回前等一小段时间：清除覆盖后浏览器要重排一帧，紧跟 `clearDeviceMetricsOverride`
 * 立刻读到的仍是旧尺寸，会把复位报成没生效。空间里没有页面时返回 `ok: false`，
 * 而不是让 `cdp()` 在无会话时抛出难懂的错误。
 * @param space - 会话的任务空间名。
 * @param request - 已校验的请求。
 * @returns 交给 `ego-browser nodejs` 的完整脚本。
 */
export function viewportScript(space: string, request: ViewportRequest): string {
  const measure = 'await page.waitForTimeout(150)\n'
    + "const __size = await page.evaluate('({ width: window.innerWidth, "
    + "height: window.innerHeight, devicePixelRatio: window.devicePixelRatio })')\n"
    + `console.log('${SENTINEL}' + JSON.stringify({ ok: true, width: __size.width, `
    + 'height: __size.height, devicePixelRatio: __size.devicePixelRatio }))\n'
  const apply = request.kind === 'reset'
    ? "await cdp('Emulation.clearDeviceMetricsOverride')\n"
    : "await cdp('Emulation.setDeviceMetricsOverride', { width: "
      + `${JSON.stringify(request.width)}, height: ${JSON.stringify(request.height)}, `
      + `deviceScaleFactor: ${JSON.stringify(request.deviceScaleFactor)}, mobile: ${JSON.stringify(request.mobile)} })\n`
  return `await taskSpaces.useOrCreate(${JSON.stringify(space)})\n`
    + 'const __tabs = await browser.listTabs()\n'
    + 'const __active = __tabs.find(t => t.active) || __tabs[0]\n'
    + 'if (!__active) {\n'
    + `  console.log('${SENTINEL}' + JSON.stringify({ ok: false, reason: 'no page is open; open a page first' }))\n`
    + '} else {\n'
    + '  await browser.switchTab(__active.targetId)\n'
    + `  ${apply.replaceAll('\n', '\n  ').trimEnd()}\n`
    + `  ${measure.replaceAll('\n', '\n  ').trimEnd()}\n`
    + '}\n'
}
