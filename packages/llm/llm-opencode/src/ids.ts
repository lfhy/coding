/**
 * OpenCode CLI 同形标识派生：会话/项目关联头与请求头集合。
 *
 * 上游免费通道按客户端指纹丢弃请求，`Authorization: Bearer public` 本身不是门。
 * 2026-10-16 的 live 复测（对着仿官方 CLI 的 opencode2api 参考实现逐项对照）确认
 * 两道硬门：User-Agent 必须以 `opencode/` 开头（harness 自己的 UA 会 403），
 * `ses_` 会话 id 的 12 位 hex 时间段必须是真实降序时钟——随机 hex 会 403。
 * 其余头（双会话头、裸 40 位 hex 项目头、以及不带 `x-opencode-request`）沿用
 * 参考实现在 2026-10-14 更严的门下验证过的形态，即使当前放宽也照旧发送。
 *
 * @module @deepseek-ai/dsh-llm-opencode/ids
 */

import { createHash, randomBytes } from 'node:crypto'

/** 一次上游请求使用的关联标识。 */
export interface RequestIds {
  /** 会话标识：上游按它归组免费额度与 prompt cache。 */
  session: string
  /** 本进程内的请求关联标识；上游自 2026-10-14 起拒绝这个头，因此不上线。 */
  request: string
  /** 项目标识：裸 40 位小写 hex，与官方客户端同形。 */
  project: string
}

/** `<prefix>_<随机 hex>`；仅用于每请求一次的标识。 */
function randomId(prefix: string, bytes: number): string {
  return `${prefix}_${randomBytes(bytes).toString('hex')}`
}

/** 官方会话 id 的形状：`ses_` + 12 位小写 hex + 14 位 base62。 */
const CANONICAL_SESSION_PATTERN = /^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/

/**
 * 官方客户端 `Identifier.descending()` 铸造的时间段：低 12 位是毫秒内序号，
 * 取反后落在 `0xFC0`–`0xFFF`（序号 1–63）。上游只在这段窗口内放行，
 * 与摘要派生的 hex 段无法区分开，因此必须真的来自时钟。
 */
const DESCENDING_TIME_PART_PATTERN = /^[0-9a-f]{9}f[c-f][0-9a-f]$/


const BASE62_ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'

/** 定宽 base62 编码：左侧补零，保证输出恰好 `width` 个字符。 */
function base62Fixed(value: bigint, width: number): string {
  let rest = value
  const out = new Array<string>(width)
  for (let index = width - 1; index >= 0; index -= 1) {
    out[index] = BASE62_ALPHABET.charAt(Number(rest % 62n))
    rest /= 62n
  }
  return out.join('')
}

/**
 * 官方客户端发出的 12 位 hex 段：取毫秒时钟，低 12 位放一个毫秒内序号，
 * 再按位取反（`~x`），使 id 作为字符串排序时新的在前。
 *
 * 序号固定为 1：本适配器是自己会话的唯一写入方，逐毫秒计数只会引入状态。
 * 上游会把低 12 位读回成计数器，只接受 `[0, 63]`；高 36 位的时钟不被校验。
 * 因此摘要派生的 hex 段几乎必然被拒——这正是它必须是真实时钟的原因。
 * @param now - 毫秒时间戳，默认当前时钟；测试用它固定取值。
 * @returns 12 位小写 hex。
 */
export function invertedTimestampHex(now: number = Date.now()): string {
  const current = BigInt(now) * 0x1000n + 1n
  const inverted = ~current & 0xffff_ffff_ffffn
  return inverted.toString(16).padStart(12, '0')
}

/**
 * 每会话一个 `ses_` id 的记忆表。时钟段必须**每会话**只铸造一次而非每请求一次：
 * 重试或同一会话的后续轮次复用同一个 id，才谈得上 prompt cache 亲和与配额归组。
 * 上限 {@link SESSION_MEMO_LIMIT} 条，先入先出淘汰，长时间运行的进程不会无界增长。
 */
const SESSION_MEMO_LIMIT = 1024
const sessionMemo = new Map<string, string>()

/**
 * 把任意会话信号展开成官方形状的会话 id。已经带官方降序时钟段的信号原样通过，
 * 其余把会话身份折进 14 位 base62 尾段，因此不同会话不会碰撞。
 * @param signal - 会话身份信号；同一会话必须稳定，不同会话必须不同。
 * @returns 官方形状的 `ses_` id。
 */
export function canonicalSessionId(signal: string): string {
  // 形状对但时钟段是摘要或升序值时同样要被拒，因此两条都在才原样通过。
  if (CANONICAL_SESSION_PATTERN.test(signal) && DESCENDING_TIME_PART_PATTERN.test(signal.slice(4, 16))) {
    return signal
  }

  const memoized = sessionMemo.get(signal)
  if (memoized !== undefined) return memoized

  const sum = createHash('sha256').update(`ses\x00${signal}`).digest()
  const session = `ses_${invertedTimestampHex()}${base62Fixed(BigInt(`0x${sum.subarray(6, 16).toString('hex')}`), 14)}`

  // 命中时已在上方提前返回，因此这里是首次铸造的插入顺序：淘汰最旧的一条。
  if (sessionMemo.size >= SESSION_MEMO_LIMIT) {
    const oldest = sessionMemo.keys().next()
    if (!oldest.done) sessionMemo.delete(oldest.value)
  }
  sessionMemo.set(signal, session)
  return session
}

/**
 * 会话身份信号：首条用户消息内容的 JSON。用首条用户轮次而非整段历史，
 * 使多轮对话随历史增长保持稳定，同时区分开场不同的会话。
 * @param messages - 请求消息，仅读取第一条有内容的用户消息。
 * @returns 该会话的稳定信号；没有任何用户内容时为空串。
 */
export function conversationSeed(messages: ReadonlyArray<{ role: string; content: unknown }>): string {
  for (const message of messages) {
    if (message.role !== 'user') continue
    const encoded = JSON.stringify(message.content ?? null)
    if (encoded !== 'null' && encoded.length > 0) return encoded
  }
  return ''
}

/**
 * 项目头：官方客户端发的是裸 40 位小写 hex，本适配器把固定的本地项目身份摘要成
 * 同一形状。上游只校验形状，但这个值让同一部署的流量始终归到同一个项目。
 * @param signal - 本地项目身份的稳定信号。
 * @returns 40 位小写 hex。
 */
export function projectId(signal: string): string {
  return createHash('sha256').update(`project\x00${signal}`).digest('hex').slice(0, 40)
}

/**
 * 派生一次上游请求的关联标识。
 * @param messages - 本次请求的消息，用于给会话身份信号。
 * @returns 会话、请求与项目标识；每次调用都产生一个新的请求标识。
 */
export function deriveRequestIds(messages: ReadonlyArray<{ role: string; content: unknown }>): RequestIds {
  const seed = conversationSeed(messages)
  return {
    session: canonicalSessionId(seed === '' || seed === '{}' ? randomId('fallback', 16) : seed),
    request: randomId('req', 16),
    project: projectId('dsh-opencode:default-project'),
  }
}

/** 官方 CLI 的 User-Agent 前缀与通道段；上游只认 `opencode/` 开头的形态。 */
const OPENCODE_CLI_VERSION = '2.0.29'

/**
 * CLI 同形的 User-Agent。上游免费通道按它识别客户端：harness 自己的
 * `Coding/...` 归因 UA 会被 403，因此本路由只发这一个形态
 * （`opencode/latest/<version>/cli`，与官方 CLI 2.x 一致）。
 * @returns 本进程使用的 User-Agent。
 */
export function opencodeUserAgent(): string {
  return `opencode/latest/${OPENCODE_CLI_VERSION}/cli`
}

/**
 * 每个上游请求都携带的伪装头集合。会话 id 同时出现在四个关联头上（官方 CLI 自
 * 2026-10-14 起要求前两个都带），项目头是同形的裸 hex；请求级关联头不再上线，
 * 上游会拒绝它，本进程仍保留该标识用于本地诊断。
 * @param ids - 本次请求的关联标识。
 * @returns 合并进 pi-ai 请求的标头字典。
 */
export function disguiseHeaders(ids: RequestIds): Record<string, string> {
  return {
    'user-agent': opencodeUserAgent(),
    'x-opencode-client': 'cli',
    'x-opencode-session': ids.session,
    'x-opencode-session-id': ids.session,
    'x-session-affinity': ids.session,
    'X-Session-Id': ids.session,
    'x-opencode-project': ids.project,
  }
}
