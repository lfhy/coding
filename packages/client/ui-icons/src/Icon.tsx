/** 用产品语义名称选择图标，隔离具体图标库和旋转规则。 */
import SemiSidebar from '@douyinfe/semi-icons/lib/es/icons/IconSidebar'
import SemiTerminal from '@douyinfe/semi-icons/lib/es/icons/IconTerminal'
import SemiImageStroked from '@douyinfe/semi-icons/lib/es/icons/IconImageStroked'
import SemiHeartStroked from '@douyinfe/semi-icons/lib/es/icons/IconHeartStroked'
import SemiExternalOpen from '@douyinfe/semi-icons/lib/es/icons/IconExternalOpenStroked'
import SemiUndo from '@douyinfe/semi-icons/lib/es/icons/IconUndo'
import SemiRedo from '@douyinfe/semi-icons/lib/es/icons/IconRedo'
import { IconTerminalOutline16, IconThinkOutline16 } from './legacy.tsx'
import { PptMark } from './PptMark.tsx'
import type { IconProps } from './props.ts'

/** 消费方使用的图标含义，不暴露第三方库中的组件名。 */
export type IconName = 'sidebar' | 'files-panel' | 'bottom-panel' | 'terminal-menu'
  | 'model-vision' | 'model-reasoning' | 'open-window' | 'favorite' | 'ppt-workbench' | 'undo' | 'redo'

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
  if (name === 'ppt-workbench') return <PptMark size={size} className={className} />
  if (name === 'undo') {
    return <SemiUndo size="inherit" style={{ fontSize: size }} className={className} aria-hidden="true" />
  }
  if (name === 'redo') {
    return <SemiRedo size="inherit" style={{ fontSize: size }} className={className} aria-hidden="true" />
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
