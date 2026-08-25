// 空白草稿阶段的会话引导层：品牌图标、标题、发光背景和工作区行。这里只承担呈现；
// 常驻编辑器仍由 ConversationRoot 持有，以便在引导层和常规编辑器间切换时保留 textarea。

import { useId } from 'react'
import type { ReactNode, RefObject } from 'react'
import {
  BrandMark, IconChevronDownOutline14, IconFolderClose16, IconFolderOpen16, IconNewChatOutline16,
} from '@deepseek-ai/dsh-client-ui-primitives'
import { workspaceTitleOf } from '@deepseek-ai/dsh-client-runtime/client'
import type { ConversationSlotProps } from '../contract/slots.ts'
import css from './HeroShell.module.css'

/** The owner's locale seat type, passed to hero chrome as a plain prop. */
type HeroTranslate = ConversationSlotProps['t']

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
  return (
    <div className={css.root}>
      <div className={css.stack}>
        <div className={css.headline}>
          {/* 品牌图标位于标题前方，和标题保持 10px 间距。 */}
          <span className={css.brandMarkHitbox}>
            {renderSlot('conversation.hero.brand.mark', { size: 34, className: css.brandMark }, {
              fallback: <BrandMark size={34} className={css.brandMark} />,
            })}
          </span>
          <span className={css.headlineText}>{t('hero.headline')}</span>
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
