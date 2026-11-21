/** 所有可配置渠道共用的流生命周期；请求编码由选中的协议实现负责。 */

import { LlmError } from 'coding-llm'
import type { StreamChunk } from 'coding-llm'
import { idleWatchdog, timeoutOf } from 'coding-timeout'

const TIMEOUT_CODE = 'LLM_STREAM_IDLE_TIMEOUT'

/** 渠道完成设置和凭据解析后交给流运行器的本次请求。 */
export interface ChannelStreamRequest {
  signal?: AbortSignal | undefined
  idleTimeoutMs: number
  open: (signal: AbortSignal, heartbeat: () => void) => AsyncIterable<StreamChunk>
}

/**
 * 消费一次协议流；调用者取消、空闲超时和提前停止消费都终止同一次上游请求。
 * @param request - 已捕获的请求及空闲时限；由协议保留自身的错误和标头语义。
 * @returns Harness 流；调用者取消和空闲超时分别抛出 `ABORTED` 与 `TIMEOUT`。
 */
export async function* streamChannelRequest(request: ChannelStreamRequest): AsyncGenerator<StreamChunk> {
  const consumer = new AbortController()
  const upstream = request.signal === undefined ? consumer.signal : AbortSignal.any([request.signal, consumer.signal])
  using watchdog = idleWatchdog(upstream, request.idleTimeoutMs, TIMEOUT_CODE)
  const iterator = request.open(watchdog.signal, () => { watchdog.pulse() })[Symbol.asyncIterator]()
  let exhausted = false
  try {
    while (true) {
      const result = await watchdog.next(iterator)
      const timeout = timeoutOf(watchdog.signal, TIMEOUT_CODE)
      if (timeout !== undefined) throw timeout
      if (result.done) {
        exhausted = true
        return
      }
      yield result.value
    }
  } catch (error: unknown) {
    if (timeoutOf(watchdog.signal, TIMEOUT_CODE) !== undefined) {
      throw new LlmError(`Stream idle timeout after ${request.idleTimeoutMs}ms`, 'TIMEOUT', { cause: error })
    }
    if (request.signal?.aborted === true) {
      throw new LlmError('Request aborted by caller', 'ABORTED', { cause: error })
    }
    throw error
  } finally {
    consumer.abort('stream consumer stopped')
    if (!exhausted && iterator.return !== undefined) {
      try {
        await iterator.return()
      } catch (_abortedTransportTeardown) {
        // 清理时的取消不覆盖本次请求的结果。
      }
    }
  }
}
