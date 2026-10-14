/** 右侧独立临时 Agent 对话：只展示该会话日志，关闭标签即撤销其 Host handle。 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { Button, ChatAssistantBody, ChatComposerAction, ChatComposerCard, ChatUserBubble, MarkdownText, MessageText, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { SessionEvent, SessionId } from '@deepseek-ai/dsh-session/types'
import type { ClientResponse, SideChatInteraction, SideChatState } from '@deepseek-ai/dsh-host-apiproxy/api'
import type { WorkspaceWorkbenchProps } from './WorkspaceWorkbench.tsx'
import css from './SideChatPanel.module.css'

/** 仅经 sideChat 专属 Host 路由读写，不借用主会话的 SessionRuntime。 */
export interface SideChatTransport {
  create: (sourceSessionId: SessionId, signal?: AbortSignal) => Promise<SessionId>
  send: (id: SessionId, text: string, signal?: AbortSignal) => Promise<void>
  state: (id: SessionId, afterSeq: number, signal?: AbortSignal) => Promise<SideChatState>
  close: (id: SessionId) => Promise<void>
  respond: (message: ClientResponse) => Promise<boolean>
}

interface SideChatProps {
  shown: boolean
  sourceSessionId: SessionId
  transport: SideChatTransport
  t: WorkspaceWorkbenchProps['t']
}

type MessageRow = { id: string; role: 'user' | 'assistant' | 'tool'; text: string }

/** 将临时会话的内存事件投影为侧聊可读行，保持原始顺序。 */
function messageRows(events: readonly SessionEvent[]): MessageRow[] {
  const rows: MessageRow[] = []
  for (const event of events) {
    switch (event.type) {
      case 'user/message': {
        if (event.data.source.kind !== 'user') break
        const text = event.data.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('')
        if (text) rows.push({ id: `user:${event.seq}`, role: 'user', text })
        break
      }
      case 'assistant/message': {
        const text = event.data.message.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('')
        if (text) rows.push({ id: `assistant:${event.seq}`, role: 'assistant', text })
        break
      }
      case 'tool/result': {
        const text = event.data.message.content.flatMap(block =>
          block.content.flatMap(item => item.type === 'text' ? [item.text] : [])).join('')
        if (text) rows.push({ id: `tool:${event.seq}`, role: 'tool', text })
        break
      }
      default: break
    }
  }
  return rows
}

/**
 * 只在本工作台标签生存期内保留 Agent：关闭、卸载时取消读取并通知 Host 释放。
 * @param props - 可见性、临时会话传输和词典。
 * @returns 文本输入、该 Agent 的独立历史与运行反馈。
 */
export function SideChatPanel({ shown, sourceSessionId, transport, t }: SideChatProps): React.JSX.Element {
  const [id, setId] = useState<SessionId | null>(null)
  const [events, setEvents] = useState<SessionEvent[]>([])
  const [running, setRunning] = useState(false)
  const [turnError, setTurnError] = useState<string | null>(null)
  const [interactions, setInteractions] = useState<SideChatInteraction[]>([])
  const [answers, setAnswers] = useState<Record<string, string>>({})
  const [choices, setChoices] = useState<Record<string, string[]>>({})
  const [draft, setDraft] = useState('')
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const agent = useRef<SessionId | null>(null)
  const creating = useRef<AbortController | null>(null)
  const afterSeq = useRef(0)
  const tail = useRef<HTMLDivElement>(null)
  const mounted = useRef(false)
  const start = useCallback((): void => {
    if (creating.current !== null || agent.current !== null) return
    const request = new AbortController()
    creating.current = request
    const launch = async (): Promise<void> => {
      try {
        const created = await transport.create(sourceSessionId, request.signal)
        if (request.signal.aborted || !mounted.current) { await transport.close(created); return }
        agent.current = created
        afterSeq.current = 0
        setId(created)
        setEvents([])
        setError(null)
      } catch (failure) {
        if (!request.signal.aborted) setError(failure instanceof Error ? failure.message : String(failure))
      } finally {
        if (creating.current === request) creating.current = null
      }
    }
    void launch()
  }, [transport, sourceSessionId])

  useEffect(() => {
    mounted.current = true
    start()
    return () => {
      mounted.current = false
      creating.current?.abort()
      creating.current = null
      const owned = agent.current
      agent.current = null
      if (owned !== null) void transport.close(owned).catch(() => undefined)
    }
  }, [start, transport])

  useEffect(() => {
    if (id === null) return
    const request = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    const poll = async (): Promise<void> => {
      try {
        const snapshot = await transport.state(id, afterSeq.current, request.signal)
        if (request.signal.aborted) return
        if (snapshot.nextSeq < afterSeq.current || snapshot.views.length !== snapshot.events.length) {
          throw new Error('Invalid temporary chat event page')
        }
        afterSeq.current = snapshot.nextSeq
        if (snapshot.events.length > 0) {
          setEvents(previous => [...previous, ...snapshot.events])
          for (const event of snapshot.events) {
            if (event.type === 'turn/start') setTurnError(null)
            if (event.type === 'turn/end' && event.data.reason.kind === 'error') {
              setTurnError(event.data.reason.error.message)
            }
          }
        }
        setRunning(snapshot.status === 'running')
        setInteractions(snapshot.interactions)
        setError(null)
        timer = setTimeout(() => { void poll() }, snapshot.hasMore ? 0 : 1200)
      } catch (failure) {
        if (request.signal.aborted) return
        setError(failure instanceof Error ? failure.message : String(failure))
        timer = setTimeout(() => { void poll() }, 3000)
      }
    }
    void poll()
    return () => { request.abort(); if (timer) clearTimeout(timer) }
  }, [id, transport])

  const rows = messageRows(events)
  const answer = async (interaction: SideChatInteraction, value?: 'allowed-once' | 'rejected'): Promise<void> => {
    if (id === null) return
    const message: ClientResponse = interaction.type === 'approval/requested'
      ? { type: 'client-response', rpcId: interaction.rpcId, result: { ok: true,
        value: { sessionId: id, approvalId: interaction.approvalId, outcome: value } } }
      : { type: 'client-response', rpcId: interaction.rpcId, result: { ok: true,
        value: { sessionId: id, answer: { answers: interaction.questions.map(question => ({
          id: question.id,
          selected: question.multiSelect || !answers[question.id]?.trim() ? choices[question.id] ?? [] : [],
          ...(answers[question.id]?.trim() ? { custom: answers[question.id]?.trim() } : {}),
        })) } } } }
    try {
      if (!await transport.respond(message)) throw new Error('The question is no longer pending')
      setInteractions(previous => previous.filter(item => item.rpcId !== interaction.rpcId))
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure))
    }
  }
  useEffect(() => { if (shown) tail.current?.scrollIntoView({ block: 'end' }) }, [events, shown])
  const send = async (): Promise<void> => {
    const value = draft.trim()
    if (value === '' || id === null || sending) return
    setSending(true)
    setError(null)
    try {
      await transport.send(id, value)
      setDraft('')
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure))
    } finally { setSending(false) }
  }
  return <section className={css.root} aria-label={t('workbench.menu.chat')}>
    <div className={css.messages} role="log" aria-live="polite">
      {rows.length === 0 && <p className={css.empty}>{t('sideChat.empty')}</p>}
      {rows.map(row => <article className={css.row} data-role={row.role} key={row.id}>
        {row.role === 'user'
          ? <ChatUserBubble><MessageText text={row.text} /></ChatUserBubble>
          : row.role === 'assistant'
            ? <ChatAssistantBody><MarkdownText text={row.text} /></ChatAssistantBody>
            : <div className={css.toolResult}>
              <strong>{t('sideChat.tool')}</strong>
              <MessageText text={row.text} />
            </div>}
      </article>)}
      {running && <p className={css.working} role="status">{t('sideChat.working')}</p>}
      {turnError !== null && <p className={css.error} role="alert">{t('sideChat.failed', { message: turnError })}</p>}
      {interactions.map(interaction => <section key={interaction.rpcId} className={css.interaction}>
        {interaction.type === 'approval/requested' ? <>
          <p>{t('sideChat.approval', { tool: interaction.toolName })}</p>
          {interaction.reason && <p>{interaction.reason}</p>}
          <Button size="sm" variant="outline" onClick={() => { void answer(interaction, 'allowed-once') }}>{t('sideChat.allow')}</Button>
          <Button size="sm" variant="outline" onClick={() => { void answer(interaction, 'rejected') }}>{t('sideChat.reject')}</Button>
        </> : <div>
          {interaction.questions.map(question => <fieldset key={question.id}>
            <legend>{question.question}</legend>
            {question.detail && <p>{question.detail}</p>}
            {question.options?.map(option => <label key={option.label}>
              <input type={question.multiSelect ? 'checkbox' : 'radio'} name={question.id}
                checked={(choices[question.id] ?? []).includes(option.label)}
                onChange={() => { setChoices((previous) => {
                  const selected = previous[question.id] ?? []
                  return { ...previous, [question.id]: question.multiSelect
                    ? selected.includes(option.label) ? selected.filter(item => item !== option.label)
                      : [...selected, option.label]
                    : [option.label] }
                }) }} />
              {option.label}
            </label>)}
            <input type="text" value={answers[question.id] ?? ''}
              aria-label={`${question.question} ${t('sideChat.other')}`}
              onChange={(event) => { setAnswers(previous => ({ ...previous,
                [question.id]: event.currentTarget.value })) }} />
          </fieldset>)}
          <Button size="sm" variant="primary" onClick={() => { void answer(interaction) }}>{t('sideChat.answer')}</Button>
        </div>}
      </section>)}
      <div ref={tail} />
    </div>
    <div className={css.composer}>
      {error !== null && <div className={css.error} role="alert">{t('sideChat.error', { message: error })}
        {id === null && <Button size="sm" variant="outline" onClick={start}>{t('sideChat.retry')}</Button>}
      </div>}
      <ChatComposerCard>
        <label className={css.label}>
          <span className={css.visuallyHidden}>{t('sideChat.placeholder')}</span>
          <textarea value={draft} disabled={id === null || sending} placeholder={t('sideChat.placeholder')}
            onChange={(event) => { setDraft(event.currentTarget.value) }}
            onKeyDown={(event) => {
              if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) return
              event.preventDefault()
              void send()
            }} />
        </label>
        <div className={css.composerRow}>
          <Tooltip label={sending ? t('sideChat.sending') : t('sideChat.send')} side="top" delayMs={500}>
            <ChatComposerAction
              aria-label={sending ? t('sideChat.sending') : t('sideChat.send')}
              disabled={id === null || sending || draft.trim() === ''}
              onClick={() => { void send() }}
            />
          </Tooltip>
        </div>
      </ChatComposerCard>
    </div>
  </section>
}
