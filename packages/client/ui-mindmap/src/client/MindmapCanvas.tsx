/** 展示带连线的导图；鼠标与方向键在同一份节点索引上操作。 */
import { useId, useLayoutEffect, useRef } from 'react'
import type { KeyboardEvent } from 'react'
import clsx from 'clsx'
import { Button, Icon } from 'coding-client-ui-primitives'
import type { PropsLocale } from 'coding-client-ui-slots'
import type { NS } from './locales.ts'
import type { MindmapTree } from './mindmap-tree.ts'
import type { MindmapNode, MindmapNodeId } from './wire.ts'
import css from './MindmapEditor.module.css'

interface CanvasProps extends PropsLocale<typeof NS> {
  tree: MindmapTree
  selectedId: MindmapNodeId
  onSelect: (id: MindmapNodeId) => void
}

interface BranchProps extends Omit<CanvasProps, 'tree'> {
  node: MindmapNode
  root?: boolean
  bind: (id: MindmapNodeId, button: HTMLButtonElement | null) => void
  onNavigate: (event: KeyboardEvent<HTMLButtonElement>, id: MindmapNodeId) => void
}

function Branch({ node, root = false, ...props }: BranchProps) {
  const { selectedId, onSelect, bind, onNavigate, t } = props
  const text = node.text.trim() === '' ? t('unnamed') : node.text
  return <li className={css.branch}>
    <Button variant="outline" className={clsx(css.node, root && css.rootNode)}
      icon={root ? <Icon name="file-mindmap" /> : undefined}
      ref={(button) => { bind(node.id, button) }} aria-pressed={selectedId === node.id}
      tabIndex={selectedId === node.id ? 0 : -1} title={text}
      onClick={() => { onSelect(node.id) }} onKeyDown={(event) => { onNavigate(event, node.id) }}>
      <span className={css.nodeText}>{text}</span>
    </Button>
    {node.children.length > 0 && <ul className={css.branches} role="list">
      {node.children.map(child => <Branch {...props} key={child.id} node={child} />)}
    </ul>}
  </li>
}

/**
 * 绘制完整分支，在当前节点附近保留图内滚动和单一 Tab 停靠点。
 * @param props - 当前快照的索引、选中节点和选择回调。
 * @returns 独立滚动、以父子路径连接的节点画布。
 */
export function MindmapCanvas({ tree, selectedId, onSelect, t }: CanvasProps) {
  const helpId = useId()
  const viewport = useRef<HTMLDivElement>(null)
  const nodes = useRef(new Map<MindmapNodeId, HTMLButtonElement>())
  const lastFocused = useRef<Element | null>(null)

  useLayoutEffect(() => {
    const frame = viewport.current
    const button = nodes.current.get(selectedId)
    /* v8 ignore next -- 当前选择来自已提交的树，节点与视口引用先于布局效果绑定。 */
    if (frame === null || button === undefined) return
    const rect = frame.getBoundingClientRect()
    const nodeRect = button.getBoundingClientRect()
    if (nodeRect.top < rect.top || nodeRect.bottom > rect.top + frame.clientHeight) {
      frame.scrollTop += nodeRect.top - rect.top - (frame.clientHeight - nodeRect.height) / 2
    }
    if (nodeRect.left < rect.left || nodeRect.right > rect.left + frame.clientWidth) {
      frame.scrollLeft += nodeRect.left - rect.left - (frame.clientWidth - nodeRect.width) / 2
    }
  }, [selectedId])

  useLayoutEffect(() => {
    // 轮询删掉当前焦点所在分支时，把键盘入口交给新的选中节点。
    if (lastFocused.current?.isConnected === false && document.activeElement === document.body) {
      nodes.current.get(selectedId)?.focus({ preventScroll: true })
    }
  }, [tree, selectedId])

  const navigate = (event: KeyboardEvent<HTMLButtonElement>, id: MindmapNodeId) => {
    const row = tree.byId.get(id)
    /* v8 ignore next -- 方向键只由已在同一棵树中渲染的节点触发。 */
    if (row === undefined) return
    let next: MindmapNodeId | undefined
    switch (event.key) {
      case 'ArrowRight': next = row.node.children[0]?.id; break
      case 'ArrowLeft': next = row.parent?.node.id; break
      case 'ArrowUp': next = tree.rows[row.start - 1]?.node.id; break
      case 'ArrowDown': next = tree.rows[row.start + 1]?.node.id; break
      case 'Home': next = tree.root.node.id; break
      case 'End': next = tree.rows.at(-1)?.node.id; break
      default: return
    }
    event.preventDefault()
    if (next === undefined) return
    onSelect(next)
    nodes.current.get(next)?.focus({ preventScroll: true })
  }

  return <div className={css.viewport} ref={viewport} role="region" aria-label={t('canvas')} aria-describedby={helpId}
    onFocus={(event) => { lastFocused.current = event.target }}
    onBlur={(event) => {
      if (event.relatedTarget !== null) lastFocused.current = null
    }}>
    <span id={helpId} className={css.srOnly}>{t('navigation')}</span>
    <ul className={css.graph} role="list">
      <Branch node={tree.root.node} root selectedId={selectedId} onSelect={onSelect} t={t}
        bind={(id, button) => { if (button === null) nodes.current.delete(id); else nodes.current.set(id, button) }}
        onNavigate={navigate} />
    </ul>
  </div>
}
