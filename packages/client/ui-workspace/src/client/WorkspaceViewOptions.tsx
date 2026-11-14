/** 分组由选项卡决定，工作与对话的菜单只编辑原有排序偏好。 */
import { useState } from 'react'
import clsx from 'clsx'
import { IconPersonalizationOutline16, Menu, Tooltip } from 'coding-client-ui-primitives'
import type { WorkspaceBrowserProps } from './contract/slots.ts'
import type { SessionOrderBy } from './stores.ts'
import css from './WorkspaceBrowser.module.css'

/**
 * 显示原有两种可编辑排序方式；最近视图不挂载此入口。
 * @param props - 共享排序偏好、写入动作与字典。
 * @returns 含原有主题与键盘交互的排序菜单。
 */
export function ViewOptionsMenu({ orderBy, onOrderPick, t }: {
  orderBy: SessionOrderBy
  onOrderPick: (mode: SessionOrderBy) => void
  t: WorkspaceBrowserProps['t']
}) {
  const [open, setOpen] = useState(false)
  return (
    <Menu open={open} onClose={() => { setOpen(false) }}
      items={[
        { type: 'label' as const, id: 'order-by', text: t('orderBy.label') },
        { id: 'manual', label: t('orderBy.manual') },
        { id: 'updated', label: t('orderBy.updated') },
      ]}
      selectedIds={[orderBy]}
      onSelect={(id) => {
        if (id === 'manual' || id === 'updated') onOrderPick(id)
        setOpen(false)
      }}
      align="end" dense portal
      anchor={(
        <Tooltip label={t('viewOptions.label')} side="bottom" delayMs={500}>
          <button type="button" className={clsx(css.iconButton, css.wide)} aria-label={t('viewOptions.label')}
            onClick={() => { setOpen(value => !value) }}>
            <IconPersonalizationOutline16 />
          </button>
        </Tooltip>
      )}
    />
  )
}
