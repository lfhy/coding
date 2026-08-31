/** 远端进程字节流在 Node Host 上的有界、同步可读投影。 */

import { Buffer } from 'node:buffer'
import type { SubprocessOutputRead, SubprocessOutputReader } from '@deepseek-ai/dsh-subprocess'

/**
 * 保存一个远端 collect 流的末尾字节窗口。
 *
 * bridge 读取在后台异步推进，公共的 `readFrom()` 仍保持 subprocess seam 的
 * 同步、offset 驱动形状。远端没有安全可供 Node Host 消费的本地 spill 路径，
 * 所以这个实现只报告内存窗口是否丢失了前缀。
 */
export class RemoteOutputReader implements SubprocessOutputReader {
  private readonly chunks: Buffer[] = []
  private retainedBytes = 0
  private totalBytes = 0
  /** 远端 agent 报告的不可用缺口所覆盖的绝对 offset。 */
  private unavailableThrough = 0

  constructor(private readonly maxBytes: number) {}

  /** 当前累计的原始字节数，供远端 reader 决定下一次 offset。 */
  get offset(): number { return this.totalBytes }

  /** 标记当前窗口之前存在远端丢失的字节。 */
  markLossy(): void { this.unavailableThrough = Math.max(this.unavailableThrough, this.totalBytes - this.retainedBytes) }

  /**
   * 将已验证的远端原始字节追加到窗口。
   * @param data - 需要保留的远端输出字节。
   */
  push(data: Uint8Array): void {
    if (data.byteLength === 0) return
    const chunk = Buffer.from(data)
    this.totalBytes += chunk.byteLength
    this.chunks.push(chunk)
    this.retainedBytes += chunk.byteLength
    while (this.retainedBytes > this.maxBytes) {
      const first = this.chunks[0]
      if (first === undefined) throw new Error('subprocess-local: remote output window lost its first chunk')
      const excess = this.retainedBytes - this.maxBytes
      if (first.byteLength <= excess) {
        this.chunks.shift()
        this.retainedBytes -= first.byteLength
      } else {
        this.chunks[0] = first.subarray(excess)
        this.retainedBytes -= excess
      }
    }
  }

  /**
   * 追加带绝对 offset 的远端响应。首次读取可能已经跳过了 agent 环形窗口
   * 之前的字节，因此不能把保留尾部重新编号为从零开始。
   * @param data - 本次响应携带的远端输出字节。
   * @param nextOffset - 远端流在本次响应后的绝对字节 offset。
   * @param lossy - 远端 agent 是否已丢弃本次窗口之前的字节。
   */
  pushRemote(data: Uint8Array, nextOffset: number, lossy: boolean): void {
    if (!Number.isSafeInteger(nextOffset) || nextOffset < 0 || nextOffset < data.byteLength) {
      throw new Error('subprocess-local: remote output returned an invalid offset')
    }
    const start = nextOffset - data.byteLength
    if (start < this.totalBytes) {
      const overlap = this.totalBytes - start
      if (overlap >= data.byteLength) {
        if (lossy) this.unavailableThrough = Math.max(this.unavailableThrough, start)
        return
      }
      data = data.subarray(overlap)
    } else if (start > this.totalBytes) {
      this.unavailableThrough = Math.max(this.unavailableThrough, start)
      this.totalBytes = start
    }
    if (lossy) this.unavailableThrough = Math.max(this.unavailableThrough, start)
    this.push(data)
    // push() 以已交付字节推进；wire offset 仍是权威值。
    this.totalBytes = nextOffset
  }

  /** @inheritdoc */
  readFrom(fromByte: number): SubprocessOutputRead {
    const firstRetained = this.totalBytes - this.retainedBytes
    const lossy = fromByte < firstRetained || fromByte < this.unavailableThrough
    const retained = Buffer.concat(this.chunks, this.retainedBytes)
    const start = lossy ? 0 : Math.min(retained.byteLength, Math.max(0, fromByte - firstRetained))
    return {
      text: retained.subarray(start).toString('utf8'),
      nextOffset: this.totalBytes,
      lossy,
    }
  }
}
