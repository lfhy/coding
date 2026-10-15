/**
 * OpenCode CLI 同形标识派生：会话/项目关联头与请求头集合。
 *
 * 上游免费通道按客户端指纹丢弃请求，`Authorization: Bearer public` 本身不是门，
 * 真正的门是 `ses_` 会话 id 的形状与派生方式。本模块把这套派生固化下来，
 * 使本适配器的流量与官方 CLI 同形。算法来自 opencode2dsh 的 live 校准结果
 * （issue #62，2026-10-13），此处逐条保留其约束而不重新发明。
 *
 * @module @deepseek-ai/dsh-llm-opencode/ids
 */

import { createHash, randomBytes } from 'node:crypto'

/** 一次上游请求使用的关联标识。 */
export interface RequestIds {
  /** 会话标识：上游按它归组免费额度与 prompt cache。 */
  session: string
  /** 本次请求的随机标识。 */
  request: string
  /** 稳定的项目标识。 */
  project: string
}

/** `sha256("<prefix>\0<value>")` 截断到 12 字节：稳定且不可逆推。 */
function stableId(prefix: string, value: string): string {
  const sum = createHash('sha256').update(`${prefix}\x00${value}`).digest()
  return `${prefix}_${sum.subarray(0, 12).toString('hex')}`
}

/** `<prefix>_<随机 hex>`；仅用于每请求一次的标识。 */
function randomId(prefix: string, bytes: number): string {
  return `${prefix}_${randomBytes(bytes).toString('hex')}`
}

/** 官方会话 id 的形状：`ses_` + 12 位小写 hex + 14 位 base62。 */
const CANONICAL_SESSION_PATTERN = /^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/

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
 * 把任意会话信号展开成官方形状的会话 id。已经是官方形状的信号原样通过，
 * 其余把会话身份折进 14 位 base62 尾段，因此不同会话不会碰撞。
 * @param signal - 会话身份信号；同一会话必须稳定，不同会话必须不同。
 * @returns 官方形状的 `ses_` id。
 */
export function canonicalSessionId(signal: string): string {
  if (CANONICAL_SESSION_PATTERN.test(signal)) return signal

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
 * 派生一次上游请求的关联标识。
 * @param messages - 本次请求的消息，用于给会话身份信号。
 * @returns 会话、请求与项目标识；每次调用都产生一个新的请求标识。
 */
export function deriveRequestIds(messages: ReadonlyArray<{ role: string; content: unknown }>): RequestIds {
  const seed = conversationSeed(messages)
  return {
    session: canonicalSessionId(seed === '' || seed === '{}' ? randomId('fallback', 16) : seed),
    request: randomId('req', 16),
    project: stableId('prj', 'dsh-opencode:default-project'),
  }
}

/**
 * CLI 同形的 User-Agent。上游按 `opencode/<version>` 识别客户端，
 * 括号内的运行时事实与官方 CLI 发出的形态一致。
 * @returns 本进程使用的 User-Agent。
 */
export function opencodeUserAgent(): string {
  return `opencode/1.18.31 (${process.platform} ${process.arch}; node${process.versions.node})`
}

/**
 * 每个上游请求都携带的伪装头集合。会话 id 同时出现在三个关联头上，
 * 与官方 CLI 的行为一致；请求头与项目头把同一次调用串起来。
 * @param ids - 本次请求的关联标识。
 * @returns 合并进 pi-ai 请求的标头字典。
 */
export function disguiseHeaders(ids: RequestIds): Record<string, string> {
  return {
    'user-agent': opencodeUserAgent(),
    'x-opencode-client': 'cli',
    'x-opencode-session': ids.session,
    'x-session-affinity': ids.session,
    'X-Session-Id': ids.session,
    'x-opencode-request': ids.request,
    'x-opencode-project': ids.project,
  }
}
