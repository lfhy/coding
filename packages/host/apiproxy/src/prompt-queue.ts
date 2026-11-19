import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from 'coding-agent'
import { isAppendSurfaceEvent } from 'coding-session'
import type { SessionEvent, UserMessage } from 'coding-session'
import type { MuxFrame, QueuedInboxItem } from './api/events.ts'

type QueueFrame = Extract<MuxFrame, { type: 'session/queue' }>

interface Transfer {
  claimed: UserMessage[]
  scheduled: boolean
}

/**
 * 将同一用户输入从队列交接到首步准备，再交给会话历史。只维护活跃 Agent 的临时投影。
 * @param ctx - API 作用域；取消装配后不推送已调度的快照。
 * @param publish - 已接纳输入快照的发布入口。
 * @returns 当前完整快照的读取函数，用于 mux 重连。
 */
export function installPromptQueue(ctx: Context, publish: (frame: QueueFrame) => void): (agent: Agent) => QueueFrame {
  const transfers = new WeakMap<Agent, Transfer>()
  let active = true
  ctx.effect(() => () => { active = false }, 'prompt queue projection')

  function snapshot(agent: Agent): QueueFrame {
    const { session, inbox } = agent
    const items: QueuedInboxItem[] = [
      ...(transfers.get(agent)?.claimed ?? []).map(message => ({ id: message.id, placement: 'preparing' as const, message })),
      ...inbox.nextTurn.map(message => ({ id: message.id, placement: 'queued' as const, message })),
      ...inbox.nextStep.map(message => ({
        id: message.id,
        placement: message.source.kind === 'user' ? 'steering' as const : 'context' as const,
        message,
      })),
    ]
    return { type: 'session/queue', sessionId: session.id, asOfSeq: session.seq - 1, items }
  }

  function stateFor(agent: Agent): Transfer {
    let state = transfers.get(agent)
    if (state === undefined) {
      state = { claimed: [], scheduled: false }
      transfers.set(agent, state)
    }
    return state
  }

  function schedule(agent: Agent, state: Transfer): void {
    if (state.scheduled) return
    state.scheduled = true
    // Inbox 在 splice 事件返回后才更新。到微任务再读，可把空闲发送的入队和同步领取合成一帧。
    queueMicrotask(() => {
      state.scheduled = false
      if (active && ctx.agents.get(agent.id) === agent) publish(snapshot(agent))
    })
  }

  ctx.on('agent/inbox/claimed', ({ agent, message }) => {
    if (agent.session.transient || ctx.agents.get(agent.id) !== agent || message.source.kind !== 'user') return
    const state = stateFor(agent)
    state.claimed.push(message)
    schedule(agent, state)
  })

  ctx.on('session/event', (session, event: SessionEvent) => {
    if (session.transient) return
    const agent = ctx.agents.get(session.id)
    if (agent?.session !== session) return
    if (event.type === 'agent/inbox/spliced') {
      schedule(agent, stateFor(agent))
      return
    }

    const state = transfers.get(agent)
    if (state === undefined || state.claimed.length === 0) return
    if (event.type === 'user/message' && isAppendSurfaceEvent(event)) {
      const claimed = state.claimed.findIndex(message => message.id === event.data.id)
      // 已进入历史的项不随重连重放；当前客户端随连续 user/message 原位交接。
      if (claimed >= 0) state.claimed.splice(claimed, 1)
    } else if (event.type === 'step/start') {
      const batch = [...state.claimed]
      // 同步写完本步的 user/message 后，剩余项是被首步处理移除或替换的输入；只清理本批，避免重入的新领取项被带走。
      queueMicrotask(() => {
        if (!active || batch.length === 0) return
        const remaining = state.claimed.filter(message => !batch.includes(message))
        if (remaining.length === state.claimed.length) return
        state.claimed = remaining
        schedule(agent, state)
      })
    } else if (event.type === 'turn/end') {
      state.claimed = []
      schedule(agent, state)
    }
  })

  return snapshot
}
