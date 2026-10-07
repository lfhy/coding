/** Electron 主进程与 Host 的私有、逐字段校验的浏览器协议。 @module @deepseek-ai/dsh-browser-electron/protocol */

import type { BrowserCapture, BrowserCommand, BrowserExpectedTarget, BrowserHumanCommand, BrowserObservation, BrowserSessionState, BrowserTabId, BrowserUseErrorCode } from '@deepseek-ai/dsh-browser'

export const MAX_PNG_BYTES = 2 * 1024 * 1024
export const MAX_BRIDGE_FRAME_BYTES = 3 * 1024 * 1024
const CODES = new Set<BrowserUseErrorCode>(['BROWSER_INVALID_URL', 'BROWSER_STALE_REF', 'BROWSER_CLOSED',
  'BROWSER_DENIED', 'BROWSER_UNAVAILABLE', 'BROWSER_FAILED', 'BROWSER_BUSY'])

export type BridgeMethod = 'prepare' | 'execute' | 'control' | 'close' | 'lease' | 'release'
export interface BridgeRequest {
  readonly v: 1
  readonly id: string
  readonly method: BridgeMethod
  readonly sessionId: string
  readonly command?: BrowserCommand | BrowserHumanCommand
  readonly expectedTarget?: BrowserExpectedTarget
}
export type BridgeValue = BrowserExpectedTarget | { readonly observation: BrowserObservation; readonly png: string | null } |
  BrowserSessionState | null
export type BridgeResponse = {
  readonly v: 1
  readonly id: string
  readonly ok: true
  readonly value: BridgeValue
} | {
  readonly v: 1
  readonly id: string
  readonly ok: false
  readonly error: { readonly code: BrowserUseErrorCode; readonly message: string }
}
export interface BridgeStateEvent {
  readonly v: 1
  readonly type: 'state'
  readonly sessionId: string
  readonly state: BrowserSessionState | null
  readonly capture?: { readonly observation: BrowserObservation; readonly png: string | null }
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
function fields(value: unknown, required: readonly string[], optional: readonly string[] = []): value is Record<string, unknown> {
  return record(value) && required.every(key => Object.hasOwn(value, key)) &&
    Object.keys(value).every(key => required.includes(key) || optional.includes(key))
}
function bounded(value: unknown, max = 256): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max
}
function integer(value: unknown, min = 0, max = Number.MAX_SAFE_INTEGER): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max
}
function session(value: unknown): value is string {
  return bounded(value) && /^[a-zA-Z0-9._~-]+$/.test(value)
}
function viewport(value: unknown): boolean {
  return fields(value, ['width', 'height']) && integer(value.width, 200, 1920) && integer(value.height, 240, 1400) &&
    value.width * value.height <= 1_800_000
}
function target(value: unknown): value is BrowserExpectedTarget {
  if (fields(value, ['kind']) && value.kind === 'none') return true
  return fields(value, ['kind', 'browserGeneration', 'stateRevision', 'tabId', 'generation'], ['url']) &&
    value.kind === 'tab' && bounded(value.browserGeneration, 128) && integer(value.stateRevision) &&
    bounded(value.tabId, 128) && bounded(value.generation, 128) &&
    (value.url === undefined || bounded(value.url, 4096))
}
function observation(value: unknown): value is BrowserObservation {
  return fields(value, ['tabId', 'generation', 'revision', 'url', 'title', 'snapshot', 'viewport', 'cursor']) &&
    bounded(value.tabId, 128) && bounded(value.generation, 128) && integer(value.revision, 0) &&
    bounded(value.url, 4096) && typeof value.title === 'string' && value.title.length <= 4096 &&
    typeof value.snapshot === 'string' && value.snapshot.length <= 12_000 && viewport(value.viewport) &&
    (value.cursor === null || fields(value.cursor, ['x', 'y', 'kind', 'at']) &&
      integer(value.cursor.x) && integer(value.cursor.y) &&
      ['click', 'fill', 'scroll'].includes(String(value.cursor.kind)) && integer(value.cursor.at))
}
/** Base64 在解析时立即解码并检查 PNG 头与字节上限。 */
export function decodeBridgePng(value: unknown): Uint8Array | null {
  if (value === null) return null
  if (typeof value !== 'string' || value.length > Math.ceil(MAX_PNG_BYTES / 3) * 4 + 4 ||
    !/^[A-Za-z0-9+/]*={0,2}$/.test(value) || value.length % 4 !== 0) throw new Error('invalid desktop browser PNG encoding')
  const bytes = Buffer.from(value, 'base64')
  if (bytes.length > MAX_PNG_BYTES || bytes.length < 8 || !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ||
    bytes.toString('base64') !== value) throw new Error('invalid desktop browser PNG bytes')
  return bytes
}
function capture(value: unknown): value is { observation: BrowserObservation; png: string | null } {
  if (!fields(value, ['observation', 'png']) || !observation(value.observation)) return false
  try { decodeBridgePng(value.png); return true } catch { return false }
}
function state(value: unknown): value is BrowserSessionState {
  if (!fields(value, ['operationActive', 'browserGeneration', 'stateRevision', 'viewport', 'tabs',
    'activeTabId', 'observation', 'hasFrame']) || typeof value.operationActive !== 'boolean' ||
    !bounded(value.browserGeneration, 128) || !integer(value.stateRevision) || !viewport(value.viewport) ||
    !Array.isArray(value.tabs) || value.tabs.length < 1 || value.tabs.length > 8 ||
    !value.tabs.every((tab: unknown) => fields(tab, ['id', 'generation', 'url', 'title', 'canGoBack', 'canGoForward'], ['loading']) &&
      bounded(tab.id, 128) && bounded(tab.generation, 128) && bounded(tab.url, 4096) &&
      typeof tab.title === 'string' && tab.title.length <= 4096 &&
      typeof tab.canGoBack === 'boolean' && typeof tab.canGoForward === 'boolean' &&
      (tab.loading === undefined || typeof tab.loading === 'boolean')) ||
    !bounded(value.activeTabId, 128) || !value.tabs.some((tab: { id: string }) => tab.id === value.activeTabId) ||
    !(value.observation === null || observation(value.observation)) || typeof value.hasFrame !== 'boolean' ||
    value.hasFrame && value.observation === null) return false
  return value.observation === null || value.observation.tabId === value.activeTabId
}
function sameObservation(left: BrowserObservation, right: BrowserObservation): boolean {
  return left.tabId === right.tabId && left.generation === right.generation && left.revision === right.revision &&
    left.url === right.url && left.title === right.title && left.snapshot === right.snapshot &&
    left.viewport.width === right.viewport.width && left.viewport.height === right.viewport.height &&
    JSON.stringify(left.cursor) === JSON.stringify(right.cursor)
}
function command(value: unknown, human: boolean): boolean {
  if (!record(value) || typeof value.kind !== 'string') return false
  const kind = value.kind
  if (kind === 'navigate' || human && kind === 'open-url') {
    return fields(value, ['kind', 'url']) && bounded(value.url, 4096)
  }
  if (human) {
    if (['ensure-tab', 'new-tab', 'back', 'forward', 'reload'].includes(kind)) return fields(value, ['kind'])
    if (['select-tab', 'close-tab'].includes(kind)) return fields(value, ['kind', 'tabId']) && bounded(value.tabId, 128)
    if (kind === 'set-viewport') return fields(value, ['kind', 'width', 'height']) && viewport({ width: value.width, height: value.height })
    const coordinates = fields(value, ['kind', 'target', 'x', 'y'], kind === 'scroll' ? ['direction', 'pixels'] : kind === 'type' ? ['text'] : []) &&
      fields(value.target, ['browserGeneration', 'stateRevision', 'tabId', 'generation', 'revision', 'viewport']) &&
      bounded(value.target.browserGeneration, 128) && integer(value.target.stateRevision) && bounded(value.target.tabId, 128) &&
      bounded(value.target.generation, 128) && integer(value.target.revision) && viewport(value.target.viewport) &&
      integer(value.x, 0, 1920) && integer(value.y, 0, 1400)
    if (!coordinates) return false
    if (kind === 'click') return true
    if (kind === 'type') return typeof value.text === 'string' && value.text.length <= 2000
    return kind === 'scroll' && ['up', 'down'].includes(String(value.direction)) && integer(value.pixels, 1, 2000)
  }
  if (['snapshot', 'screenshot', 'close'].includes(kind)) return fields(value, ['kind'])
  if (kind === 'click') return fields(value, ['kind', 'ref', 'revision']) && bounded(value.ref, 256) && integer(value.revision, 1)
  if (kind === 'fill') return fields(value, ['kind', 'ref', 'revision', 'text']) && bounded(value.ref, 256) &&
    integer(value.revision, 1) && typeof value.text === 'string' && value.text.length <= 2000
  return kind === 'scroll' && fields(value, ['kind', 'direction', 'pixels']) &&
    ['up', 'down'].includes(String(value.direction)) && integer(value.pixels, 1, 2000)
}

/** 主进程在执行任何命令前解析 Host 请求；额外字段一律拒绝。 */
export function parseBridgeRequest(value: unknown): BridgeRequest {
  if (!fields(value, ['v', 'id', 'method', 'sessionId'], ['command', 'expectedTarget']) || value.v !== 1 ||
    !bounded(value.id, 128) || !session(value.sessionId) ||
    !['prepare', 'execute', 'control', 'close', 'lease', 'release'].includes(String(value.method)) ||
    (value.method === 'execute' ? !command(value.command, false) ||
      value.expectedTarget !== undefined && !target(value.expectedTarget) :
      value.method === 'control' ? !command(value.command, true) || value.expectedTarget !== undefined :
        value.command !== undefined || value.expectedTarget !== undefined)) throw new Error('invalid desktop browser request')
  return value as unknown as BridgeRequest
}

/** 响应按请求方法验证，防止有效 JSON 的错位数据变成状态或捕获。 */
export function parseBridgeResponse(value: unknown, method: BridgeMethod): BridgeResponse {
  if (!record(value) || value.v !== 1 || !bounded(value.id, 128)) throw new Error('invalid desktop browser response')
  if (fields(value, ['v', 'id', 'ok', 'error']) && value.ok === false &&
    fields(value.error, ['code', 'message']) && CODES.has(value.error.code as BrowserUseErrorCode) &&
    bounded(value.error.message, 512)) return value as unknown as BridgeResponse
  if (!fields(value, ['v', 'id', 'ok', 'value']) || value.ok !== true ||
    !(method === 'prepare' ? target(value.value) : method === 'execute' ? capture(value.value) :
      method === 'control' ? value.value === null || state(value.value) : value.value === null)) {
    throw new Error('invalid desktop browser response')
  }
  return value as unknown as BridgeResponse
}

/** 事件可先于响应送达；状态与画面必须指向同一活跃标签页。 */
export function parseBridgeEvent(value: unknown): BridgeStateEvent {
  if (!fields(value, ['v', 'type', 'sessionId', 'state'], ['capture']) || value.v !== 1 ||
    value.type !== 'state' || !session(value.sessionId) || !(value.state === null || state(value.state)) ||
    (value.capture !== undefined && (!capture(value.capture) || value.state === null ||
      value.state.observation === null || !value.state.hasFrame ||
      value.capture.observation.tabId !== value.state.activeTabId ||
      !sameObservation(value.capture.observation, value.state.observation) ||
      value.capture.png === null))) throw new Error('invalid desktop browser state event')
  return value as unknown as BridgeStateEvent
}

/** 将已校验的 wire 截图转为服务使用的字节，不能把 base64 暴露给 HTTP 路由。 */
export function decodeBridgeCapture(value: { readonly observation: BrowserObservation; readonly png: string | null }): BrowserCapture {
  return { observation: value.observation, png: decodeBridgePng(value.png) }
}

/** 检查 WebSocket 单帧体积后再执行 JSON.parse。 */
export function parseBridgeFrame(data: Buffer | string): unknown {
  const bytes = Buffer.isBuffer(data) ? data : Buffer.from(data)
  if (bytes.length > MAX_BRIDGE_FRAME_BYTES) throw new Error('desktop browser frame exceeds limit')
  return JSON.parse(bytes.toString('utf8')) as unknown
}

export type { BrowserTabId }
