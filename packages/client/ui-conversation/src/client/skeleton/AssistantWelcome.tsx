import clsx from 'clsx'
import {
  BrandMark, Button, IconChevronRightOutline14, IconCodeOutline16, IconEditOutline16, IconLightOutline16,
  IconListPenOutline16,
} from 'coding-client-ui-primitives'
import { useId, type ReactNode } from 'react'
import type { SessionId } from 'coding-client-runtime/client'
import type { ConversationSlotProps } from '../contract/slots.ts'
import { heroGreetingKey } from './EmptyHero.tsx'
import css from './AssistantWelcome.module.css'

type AssistantTranslate = ConversationSlotProps['t']

interface Shortcut {
  readonly label: string
  readonly description: string
  readonly prompt: string
  readonly icon: ReactNode
  readonly tone: 'writing' | 'summary' | 'code' | 'inspiration'
}

/** 同一笔记目录里已有的一轮对话；点开即接续该会话。 */
interface AssistantRecentSession {
  readonly id: SessionId
  readonly title: string | undefined
}

/**
 * 笔记页助手的紧凑空态；快捷项只预填共享草稿，不替用户提交消息。
 * @param props - 本地化、共享草稿预填动作、当前笔记目录已有的会话摘要及其接续动作。
 * @returns 助手欢迎内容。
 */
export function AssistantWelcome({ t, onPrompt, recentSessions, onResume }: {
  t: AssistantTranslate
  onPrompt: ((prompt: string) => void) | undefined
  recentSessions: readonly AssistantRecentSession[] | undefined
  onResume: (sessionId: SessionId) => void
}) {
  const id = useId()
  const shortcuts: readonly Shortcut[] = [
    {
      label: t('assistant.shortcut.writing'), description: t('assistant.shortcut.writing.description'),
      prompt: t('assistant.prompt.writing'), icon: <IconEditOutline16 />, tone: 'writing',
    },
    {
      label: t('assistant.shortcut.summary'), description: t('assistant.shortcut.summary.description'),
      prompt: t('assistant.prompt.summary'), icon: <IconListPenOutline16 />, tone: 'summary',
    },
    {
      label: t('assistant.shortcut.code'), description: t('assistant.shortcut.code.description'),
      prompt: t('assistant.prompt.code'), icon: <IconCodeOutline16 />, tone: 'code',
    },
    {
      label: t('assistant.shortcut.inspiration'), description: t('assistant.shortcut.inspiration.description'),
      prompt: t('assistant.prompt.inspiration'), icon: <IconLightOutline16 />, tone: 'inspiration',
    },
  ]

  return (
    <section className={css.root} aria-labelledby={`${id}-greeting`} data-assistant-welcome>
      <div className={css.headline}>
        <BrandMark size={32} className={css.brandMark} />
        <div className={css.headlineCopy}>
          <h3 id={`${id}-greeting`} className={css.greeting}>{t(heroGreetingKey(new Date().getHours()))}</h3>
          <p className={css.description}>{t('assistant.description')}</p>
        </div>
      </div>
      <div className={css.shortcuts}>
        {shortcuts.map(shortcut => (
          <Button
            key={shortcut.tone}
            className={clsx(css.shortcut, css[shortcut.tone])}
            variant="outline"
            aria-labelledby={`${id}-${shortcut.tone}-title`}
            aria-describedby={`${id}-${shortcut.tone}-description`}
            disabled={onPrompt === undefined}
            onClick={() => { onPrompt?.(shortcut.prompt) }}
          >
            <span className={css.cardIcon} aria-hidden="true">{shortcut.icon}</span>
            <span className={css.cardCopy}>
              <span id={`${id}-${shortcut.tone}-title`} className={css.cardTitle}>{shortcut.label}</span>
              <span id={`${id}-${shortcut.tone}-description`} className={css.cardDescription}>{shortcut.description}</span>
            </span>
          </Button>
        ))}
      </div>
      {recentSessions !== undefined && <section className={css.recent} aria-labelledby={`${id}-recent`}>
        <h4 id={`${id}-recent`} className={css.recentTitle}>{t('assistant.recent.title')}</h4>
        {recentSessions.length === 0
          ? <p className={css.recentEmpty}>{t('assistant.recent.empty')}</p>
          : <ul className={css.recentList}>
            {recentSessions.map((session) => {
              const title = session.title?.trim() || t('assistant.recent.untitled')
              return (
                <li key={session.id}>
                  <Button className={css.recentSession} size="sm" title={title}
                    onClick={() => { onResume(session.id) }}>
                    <span className={css.recentSessionTitle}>{title}</span>
                    <IconChevronRightOutline14 />
                  </Button>
                </li>
              )
            })}
          </ul>}
      </section>}
    </section>
  )
}
