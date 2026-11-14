import type { SessionId } from 'coding-client-runtime/client'

/** 新对话页面独立持有的发起方式，不表示侧栏浏览状态。 */
export type NewConversationMode = 'work' | 'conversation'

/** 顶部胶囊只读取页面 owner，并将用户选择单向交还页面。 */
export interface HeroModeOwnerProps {
  mode: NewConversationMode
  busy: boolean
  onPick: (mode: NewConversationMode) => void
  /** 胶囊及其内容面板共用的可访问性标识前缀。 */
  id: string
}

declare module '@deepseek-ai/cordis' {
  interface Events {
    /**
     * 无项目对话在打开与迁移输入前等待模式拥有者完成标准模式准备；失败拒绝入口。
     * @param sessionId - 已创建或复用、尚未开始的目标会话，不是来源工作会话。
     * @mode serial
     */
    'conversation/prepare-standalone'(sessionId: SessionId): Promise<void>
  }
}
