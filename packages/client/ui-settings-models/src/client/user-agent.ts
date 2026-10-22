/**
 * 渠道级模型请求 UA 的表单校验。
 *
 * Host 侧把同一份规则写在 `coding-llm` 的 `MODEL_USER_AGENT_PATTERN` 里，由各渠道
 * 的 settings schema 复用；浏览器的源码平面不能直接引用那半边的实现，因此在这里
 * 镜像一份，字段上先给出可读诊断，不必等一次被拒绝的写入。
 */

/** UA 标头值的长度上限，与 Host 侧 schema 一致。 */
export const MAX_USER_AGENT_LENGTH = 256

/**
 * 判断键入的 UA 能否作为 HTTP 标头值发送。
 * @param value - 已去掉首尾空白的输入。
 * @returns 非空、1–256 个可打印 ASCII 且首尾不是空格时为 true。
 */
export function validChannelUserAgent(value: string): boolean {
  return value.length > 0 && value.length <= MAX_USER_AGENT_LENGTH
    && /^[\x21-\x7E](?:[\x20-\x7E]*[\x21-\x7E])?$/.test(value)
}
