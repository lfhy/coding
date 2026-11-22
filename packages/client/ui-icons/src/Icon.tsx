/** 用产品语义名称选择图标，隔离具体图标库和旋转规则。 */
import SemiSidebar from '@douyinfe/semi-icons/lib/es/icons/IconSidebar'
import SemiTerminal from '@douyinfe/semi-icons/lib/es/icons/IconTerminal'
import SemiImageStroked from '@douyinfe/semi-icons/lib/es/icons/IconImageStroked'
import SemiHeartStroked from '@douyinfe/semi-icons/lib/es/icons/IconHeartStroked'
import SemiExternalOpen from '@douyinfe/semi-icons/lib/es/icons/IconExternalOpenStroked'
import SemiUndo from '@douyinfe/semi-icons/lib/es/icons/IconUndo'
import SemiRedo from '@douyinfe/semi-icons/lib/es/icons/IconRedo'
import SemiHandle from '@douyinfe/semi-icons/lib/es/icons/IconHandle'
import SemiHome from '@douyinfe/semi-icons/lib/es/icons/IconHomeStroked'
import SemiConversation from '@douyinfe/semi-icons/lib/es/icons/IconCommentStroked'
import SemiRecent from '@douyinfe/semi-icons/lib/es/icons/IconClockStroked'
import SemiFile from '@douyinfe/semi-icons/lib/es/icons/IconFile'
import SemiGallery from '@douyinfe/semi-icons/lib/es/icons/IconGallery'
import SemiBranch from '@douyinfe/semi-icons/lib/es/icons/IconBranch'
import SemiWord from '@douyinfe/semi-icons/lib/es/icons/IconWord'
import SemiExcel from '@douyinfe/semi-icons/lib/es/icons/IconExcel'
import SemiFolderOpen from '@douyinfe/semi-icons/lib/es/icons/IconFolderOpenStroked'
import SemiInbox from '@douyinfe/semi-icons/lib/es/icons/IconInbox'
import SemiTextStroked from '@douyinfe/semi-icons/lib/es/icons/IconTextStroked'
import SemiBold from '@douyinfe/semi-icons/lib/es/icons/IconBold'
import SemiItalic from '@douyinfe/semi-icons/lib/es/icons/IconItalic'
import SemiHeading from '@douyinfe/semi-icons/lib/es/icons/IconH2'
import SemiList from '@douyinfe/semi-icons/lib/es/icons/IconList'
import SemiQuote from '@douyinfe/semi-icons/lib/es/icons/IconQuote'
import { IconTerminalOutline16, IconThinkOutline16 } from './legacy.tsx'
import { PptMark } from './PptMark.tsx'
import type { IconProps } from './props.ts'

/** 消费方使用的图标含义，不暴露第三方库中的组件名。 */
export type IconName = 'sidebar' | 'files-panel' | 'bottom-panel' | 'terminal-menu'
  | 'model-vision' | 'model-reasoning' | 'open-window' | 'favorite' | 'ppt-workbench' | 'undo' | 'redo'
  | 'drag-handle' | 'home' | 'conversation' | 'recent' | 'file' | 'file-slides' | 'file-mindmap' | 'files' | 'file-other'
  | 'file-word' | 'file-excel'
  | 'notes'
  | 'format-bold' | 'format-italic' | 'format-heading' | 'format-list' | 'format-quote'

const formatting = {
  'format-bold': SemiBold,
  'format-italic': SemiItalic,
  'format-heading': SemiHeading,
  'format-list': SemiList,
  'format-quote': SemiQuote,
}

/** 产品语义名称加上共享的布局属性。 */
export interface SemanticIconProps extends IconProps {
  name: IconName
}

/**
 * 渲染产品语义图标；图标自身不提供按钮的可访问名称。
 * @param props - 语义名称、像素尺寸和布局类名。
 * @returns 隐藏于无障碍树的语义图标。
 */
export function Icon({ name, size = 16, className }: SemanticIconProps) {
  if (name === 'format-bold' || name === 'format-italic' || name === 'format-heading'
    || name === 'format-list' || name === 'format-quote') {
    const Glyph = formatting[name]
    return <Glyph size="inherit" style={{ fontSize: size }} className={className} aria-hidden="true" />
  }
  if (name === 'conversation') {
    return <SemiConversation size="inherit" style={{ fontSize: size }} className={className} aria-hidden="true" />
  }
  if (name === 'recent') {
    return <SemiRecent size="inherit" style={{ fontSize: size }} className={className} aria-hidden="true" />
  }
  if (name === 'home') {
    return <SemiHome size="inherit" style={{ fontSize: size }} className={className} aria-hidden="true" />
  }
  if (name === 'ppt-workbench') return <PptMark size={size} className={className} />
  if (name === 'undo') {
    return <SemiUndo size="inherit" style={{ fontSize: size }} className={className} aria-hidden="true" />
  }
  if (name === 'redo') {
    return <SemiRedo size="inherit" style={{ fontSize: size }} className={className} aria-hidden="true" />
  }
  if (name === 'drag-handle') {
    return <SemiHandle size="inherit" style={{ fontSize: size }} className={className} aria-hidden="true" />
  }
  if (name === 'bottom-panel') {
    return <SemiTerminal size="inherit" style={{ fontSize: size }} className={className} aria-hidden="true" />
  }
  if (name === 'terminal-menu') return <IconTerminalOutline16 size={size} className={className} />
  if (name === 'model-vision') {
    return <SemiImageStroked size="inherit" style={{ fontSize: size }} className={className} aria-hidden="true" />
  }
  if (name === 'favorite') {
    return <SemiHeartStroked size="inherit" style={{ fontSize: size }} className={className} aria-hidden="true" />
  }
  if (name === 'model-reasoning') return <IconThinkOutline16 size={size} className={className} />
  if (name === 'file') {
    return <SemiFile size="inherit" style={{ fontSize: size }} className={className} aria-hidden="true" />
  }
  if (name === 'file-slides') {
    return <SemiGallery size="inherit" style={{ fontSize: size }} className={className} aria-hidden="true" />
  }
  if (name === 'file-mindmap') {
    return <SemiBranch size="inherit" style={{ fontSize: size }} className={className} aria-hidden="true" />
  }
  if (name === 'file-word' || name === 'file-excel') {
    const Glyph = name === 'file-word' ? SemiWord : SemiExcel
    return <Glyph size="inherit" style={{ fontSize: size }} className={className} aria-hidden="true" />
  }
  if (name === 'files') {
    return <SemiFolderOpen size="inherit" style={{ fontSize: size }} className={className} aria-hidden="true" />
  }
  if (name === 'file-other') {
    return <SemiInbox size="inherit" style={{ fontSize: size }} className={className} aria-hidden="true" />
  }
  if (name === 'notes') {
    return <SemiTextStroked size="inherit" style={{ fontSize: size }} className={className} aria-hidden="true" />
  }
  if (name === 'open-window') {
    return <SemiExternalOpen size="inherit" style={{ fontSize: size }} className={className} aria-hidden="true" />
  }
  return (
    <SemiSidebar
      size="inherit"
      style={{ fontSize: size }}
      className={className}
      {...name === 'files-panel' ? { rotate: 180 } : {}}
      aria-hidden="true"
    />
  )
}
