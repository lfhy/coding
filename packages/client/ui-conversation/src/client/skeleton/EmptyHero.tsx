// 空白草稿阶段的会话引导层：品牌图标、时段问候、发光背景和工作区行。这里只承担呈现；
// 常驻编辑器仍由 ConversationRoot 持有，以便在引导层和常规编辑器间切换时保留 textarea。

import { useEffect, useId, useState } from 'react'
import type { ReactNode, RefObject } from 'react'
import {
  BrandMark, IconChevronDownOutline14, IconFolderClose16, IconFolderOpen16, IconNewChatOutline16,
} from '@deepseek-ai/dsh-client-ui-primitives'
import { workspaceTitleOf } from '@deepseek-ai/dsh-client-runtime/client'
import type { ConversationSlotProps } from '../contract/slots.ts'
import css from './HeroShell.module.css'

/** The owner's locale seat type, passed to hero chrome as a plain prop. */
type HeroTranslate = ConversationSlotProps['t']

/** 空态问候按本地时间划分的四个时段。 */
export type HeroGreetingPeriod = 'morning' | 'noon' | 'afternoon' | 'evening'

/** 空态问候使用的本地化键。 */
export type HeroGreetingKey =
  | 'hero.greeting.morning'
  | 'hero.greeting.noon'
  | 'hero.greeting.afternoon'
  | 'hero.greeting.evening'

/**
 * 根据本地小时选择空态问候时段。
 * @param hour - `Date#getHours()` 返回的本地小时。
 * @returns 当前问候时段。
 */
export function heroGreetingPeriod(hour: number): HeroGreetingPeriod {
  if (hour >= 5 && hour < 11) return 'morning'
  if (hour >= 11 && hour < 14) return 'noon'
  if (hour >= 14 && hour < 19) return 'afternoon'
  return 'evening'
}

/**
 * 根据本地小时返回空态问候的本地化键。
 * @param hour - `Date#getHours()` 返回的本地小时。
 * @returns 问候文案键。
 */
export function heroGreetingKey(hour: number): HeroGreetingKey {
  return `hero.greeting.${heroGreetingPeriod(hour)}`
}

/**
 * 计算下一次问候时段切换前的等待时间。
 * @param now - 当前本地时间。
 * @returns 到下一个时段边界的毫秒数，包含一个短暂的边界缓冲。
 */
export function heroGreetingDelay(now: Date): number {
  const hour = now.getHours()
  const nextHour = hour < 5 ? 5 : hour < 11 ? 11 : hour < 14 ? 14 : hour < 19 ? 19 : 5
  const next = new Date(now)
  next.setMinutes(0, 0, 0)
  if (nextHour <= hour) next.setDate(next.getDate() + 1)
  next.setHours(nextHour, 0, 0, 0)
  return Math.max(1_000, next.getTime() - now.getTime() + 100)
}

/** 只在四个时段边界更新一次，避免空态组件随分钟变化反复渲染。 */
function useHeroClock(): Date {
  const [now, setNow] = useState(() => new Date())

  useEffect(() => {
    const timer = setTimeout(() => { setNow(new Date()) }, heroGreetingDelay(now))
    return () => { clearTimeout(timer) }
  }, [now])

  return now
}

/**
 * Basename label for the workspace chip (the shared derivation);
 * separator-only paths echo the raw cwd.
 * @param cwd - workspace directory path (non-empty).
 * @returns chip label.
 */
export function workspaceLabel(cwd: string): string {
  const base = workspaceTitleOf(cwd)
  return base !== '' ? base : cwd
}

/** 会话引导区的工作区状态入口；无项目会话显示聊天图标。 */
export function WorkspaceChip({ buttonRef, label, mode, menuOpen = false, onClick, t }: {
  buttonRef?: RefObject<HTMLButtonElement>
  label?: string | undefined
  mode?: 'no-project' | undefined
  menuOpen?: boolean
  onClick?: () => void
  t: HeroTranslate
}) {
  return (
    <button
      ref={buttonRef}
      type="button"
      className={css.workspace}
      aria-label={t('hero.chooseWorkspace')}
      aria-haspopup="menu"
      aria-expanded={menuOpen}
      onClick={onClick}
    >
      {label === undefined
        ? <IconFolderClose16 className={css.folder} size={16} />
        : mode === 'no-project'
          ? <IconNewChatOutline16 className={css.folder} size={16} />
          : <IconFolderOpen16 className={css.folder} size={16} />}
      <span className={css.workspaceLabel}>{label ?? t('hero.chooseWorkspace')}</span>
      <IconChevronDownOutline14 className={css.chevron} size={12} />
    </button>
  )
}

/**
 * The soft blue backdrop ellipse (figma 313:14109). Rendered by the hero
 * owner (ConversationRoot), not HeroShell, so it can center on the input
 * card; the owner's className supplies all positioning.
 * @param props.className - positioning class from the owner.
 * @returns the blurred-ellipse svg element.
 */
export function HeroGlow({ className }: { className?: string | undefined }) {
  // Stable filter id so multiple hero mounts do not collide in the DOM.
  const glowFilterId = `empty-glow-${useId().replace(/:/g, '')}`
  return (
    <svg className={className} viewBox="0 0 1051 468" fill="none" aria-hidden="true">
      <defs>
        <filter
          id={glowFilterId}
          x="0"
          y="0"
          width="1051"
          height="468"
          filterUnits="userSpaceOnUse"
          colorInterpolationFilters="sRGB"
        >
          <feFlood floodOpacity="0" result="BackgroundImageFix" />
          <feBlend mode="normal" in="SourceGraphic" in2="BackgroundImageFix" result="shape" />
          <feGaussianBlur stdDeviation="50" result="effect1_foregroundBlur" />
        </filter>
      </defs>
      <g filter={`url(#${glowFilterId})`}>
        <ellipse cx="525.5" cy="234" rx="425.5" ry="134" fill="#6187D8" fillOpacity="0.08" />
      </g>
    </svg>
  )
}

/** 会话引导层的属性；工作区行由 InputBar 的 accessory slot 承载。 */
export interface HeroShellProps {
  /** owner 的 locale seat，以普通属性传入。 */
  t: HeroTranslate
  /** 获授权的会话引导品牌 slot 渲染函数。 */
  renderSlot: ConversationSlotProps['renderSlot']
  /** 位于内容栈之后的叠层内容（如模态框）。 */
  children?: ReactNode
}

/**
 * 渲染会话引导层的标题部分；发光背景、编辑器和工作区行由 owner 单独持有。
 * @param props - 见 {@link HeroShellProps}。
 * @returns 居中的会话引导元素树。
 */
export function HeroShell({ t, renderSlot, children }: HeroShellProps) {
  const now = useHeroClock()

  return (
    <div className={css.root}>
      <div className={css.stack}>
        <div className={css.headline}>
          {/* 品牌图标位于问候前方，和文字保持 10px 间距。 */}
          <span className={css.brandMarkHitbox} data-testid="hero-brand-mark">
            {renderSlot('conversation.hero.brand.mark', { size: 34, className: css.brandMark }, {
              fallback: <BrandMark size={34} className={css.brandMark} />,
            })}
          </span>
          <span className={css.greetingText} data-testid="hero-greeting">
            {t(heroGreetingKey(now.getHours()))}
          </span>
        </div>
        <div className={css.body}>
          {/* The resident composer (ConversationRoot's root-owned scrollport;
              the workspace row rides the stack above the card) is CSS-centered
              in that scroll body during hero — see
              ConversationRoot.module.css [data-phase='hero']. */}
        </div>
      </div>
      {children}
    </div>
  )
}
