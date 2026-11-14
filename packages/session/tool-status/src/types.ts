/** 当前轮次的模型进度事实与浏览器共享投影，入口不携带 Host 实现。 */

declare module 'coding-session/types' {
  interface SessionEventMap {
    /** 模型报告的完整当前进度；text 为 null 时恢复自动跟随待办或目标。 */
    'status/set': { turn: number; text: string | null }
  }
}

declare module 'coding-session-projection/types' {
  interface SessionProjectionMap {
    /** 当前轮次的手动进度；首次设置前、清除后及轮次边界均为 null。 */
    turnStatus: string | null
  }
}

export {}
