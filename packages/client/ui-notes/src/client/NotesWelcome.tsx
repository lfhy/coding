import { IconListPenOutline16, IconSparkle16 } from 'coding-client-ui-primitives'
import type { PropsLocale } from 'coding-client-ui-slots'
import type { NS } from './locales.ts'
import css from './NotesPage.module.css'

/**
 * 未选中笔记时，正文区只显示欢迎内容；新建入口由目录持有。
 * @param props - 欢迎标题与说明所用的本地化文案。
 * @returns 笔记欢迎区。
 */
export function NotesWelcome({ t }: PropsLocale<typeof NS>) {
  const hour = new Date().getHours()
  const greeting = hour < 12 ? 'welcomeMorning' : hour < 18 ? 'welcomeAfternoon' : 'welcomeEvening'

  return (
    <div className={css.welcome}>
      <div className={css.welcomeContent}>
        <div className={css.welcomeArt} aria-hidden="true">
          <IconListPenOutline16 size={58} />
          <IconSparkle16 size={18} className={css.welcomeSparkle} />
        </div>
        <h2>{t(greeting)}</h2>
        <p>{t('welcomeDescription')}</p>
      </div>
    </div>
  )
}
