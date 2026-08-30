/** 为本地 Host 生命周期消费者统计存活的 WebSocket 下行连接。 */

/** 下行连接数量变化后收到通知的监听器。 */
export type WebClientConnectionListener = (count: number) => void

/**
 * 追踪活跃的 WebSocket 下行连接而不分配客户端身份。浏览器使用两条独立流，
 * 消费者只依赖零与非零的区别；每条流拥有一个返回的释放函数。
 */
export class WebClientConnections {
  private readonly live = new Set<symbol>()
  private readonly listeners = new Set<WebClientConnectionListener>()

  /** 当前已打开的下行 socket 数量。 */
  get count(): number {
    return this.live.size
  }

  /**
   * 登记一个已打开的下行连接，并返回幂等的关闭释放函数。
   * @returns 用于撤销本次连接登记的幂等函数。
   */
  attach(): () => void {
    const token = Symbol('web-client-connection')
    this.live.add(token)
    this.notify()
    let detached = false
    return () => {
      if (detached) return
      detached = true
      this.live.delete(token)
      this.notify()
    }
  }

  /**
   * 订阅后续数量变化；当前状态仍可通过 {@link count} 读取。
   * @param listener - 收到最新活跃连接数量的监听器。
   * @returns 用于撤销该监听器的函数。
   */
  subscribe(listener: WebClientConnectionListener): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  private notify(): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(this.count)
      } catch (error) {
        console.error('[client-connection] web-client connection listener threw:', error)
      }
    }
  }
}
