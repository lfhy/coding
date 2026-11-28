import type { ReactNode } from 'react'
import type { IdeLayoutNode } from './ide-store.ts'
import css from './IdeWorkspace.module.css'

interface IdeLayoutTreeProps {
  /** 当前工作区的分组树。 */
  node: IdeLayoutNode
  /** 叶子节点对应的编辑器分组；key 由调用方设置。 */
  renderPane: (paneId: string) => ReactNode
}

/** 递归渲染分组树，让任意分组都能继续左右或上下拆分。 */
export function IdeLayoutTree({ node, renderPane }: IdeLayoutTreeProps): ReactNode {
  if (node.kind === 'pane') return renderPane(node.paneId)
  return <div className={css.layoutSplit} data-orientation={node.orientation}>
    {node.children.map((child, index) => <div key={index} className={css.layoutBranch}>
      <IdeLayoutTree node={child} renderPane={renderPane} />
    </div>)}
  </div>
}
