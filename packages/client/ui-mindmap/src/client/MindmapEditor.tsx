/** 笔记正文中的导图编辑器；路径、画布快照与未提交表单分别管理。 */
import { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react'
import {
  Button, Icon, IconChevronDownOutline14, IconChevronUpOutline14, IconEditOutline16, IconEllipsisOutline16,
  IconPlusOutline16, IconRefreshOutline16, IconTrashOutline16, Menu, Toast,
} from 'coding-client-ui-primitives'
import type { PropsLocale, PropsRuntime } from 'coding-client-ui-slots'
import type { NS } from './locales.ts'
import { MindmapCanvas } from './MindmapCanvas.tsx'
import { MindmapEditDialog } from './MindmapEditDialog.tsx'
import { createDraft, editFromDraft, type BranchAction, type EditDraft } from './mindmap-edits.ts'
import { indexMindmap, moveDestinations } from './mindmap-tree.ts'
import { useMindmapDocument } from './useMindmapDocument.ts'
import type { MindmapNodeId } from './wire.ts'
import css from './MindmapEditor.module.css'

type EditorSlotProps = PropsRuntime<'notes.document.mindmap'> & PropsLocale<typeof NS>
type DocumentEditorProps = Pick<EditorSlotProps, 'path' | 't'>
type DialogIssue = 'conflict' | 'refreshFailed' | 'saveFailed'

/**
 * 为笔记页的可见导图挂接编辑器。换路径或隐藏均结束旧实例的读写与弹窗。
 * @param props - 笔记内容插槽提供的路径、显隐和文案。
 * @returns 当前路径的可视化编辑器，或隐藏时的空内容。
 */
export function MindmapEditor({ path, shown, t }: EditorSlotProps) {
  return shown ? <DocumentEditor key={path} path={path} t={t} /> : null
}

function DocumentEditor({ path, t }: DocumentEditorProps) {
  const document = useMindmapDocument(path)
  const { activity, snapshot, issue } = document
  const [selection, setSelection] = useState<MindmapNodeId>()
  const [draft, setDraft] = useState<EditDraft | null>(null)
  const [dialogIssue, setDialogIssue] = useState<DialogIssue | null>(null)
  const [moreOpen, setMoreOpen] = useState(false)
  const [toast, setToast] = useState(0)
  const addButton = useRef<HTMLButtonElement>(null)
  const moreButton = useRef<HTMLButtonElement>(null)
  const refreshButton = useRef<HTMLButtonElement>(null)
  const returnFocus = useRef<HTMLButtonElement | null>(null)
  const clearToast = useCallback(() => { setToast(0) }, [])
  const tree = useMemo(() => snapshot === null ? null : indexMindmap(snapshot.document.root), [snapshot])
  const selected = (selection === undefined ? undefined : tree?.byId.get(selection)) ?? tree?.root
  const busy = activity !== null
  const hasBranch = selected !== undefined && selected.parent !== null
  const menuVisible = moreOpen && hasBranch && !busy
  const canMove = hasBranch && tree !== null && moveDestinations(tree, selected.node.id).length > 0
  const branchActions = [
    { id: 'move', label: t('move'), icon: <Icon name="file-mindmap" />, disabled: !canMove },
    { id: 'earlier', label: t('earlier'), icon: <IconChevronUpOutline14 />, disabled: !hasBranch || selected.siblingIndex === 0 },
    { id: 'later', label: t('later'), icon: <IconChevronDownOutline14 />,
      disabled: selected?.parent == null || selected.siblingIndex >= selected.parent.node.children.length - 1 },
    { id: 'delete', label: t('delete'), icon: <IconTrashOutline16 />, disabled: !hasBranch, danger: true },
  ] as const

  useLayoutEffect(() => {
    const trigger = returnFocus.current
    if (draft !== null || trigger === null) return
    returnFocus.current = null
    if (!trigger.disabled) trigger.focus({ preventScroll: true })
    else if (addButton.current?.disabled === false) addButton.current.focus({ preventScroll: true })
    else refreshButton.current?.focus({ preventScroll: true })
  }, [draft])

  const openDialog = (action: BranchAction, trigger: HTMLButtonElement | null) => {
    /* v8 ignore next -- 没有可用快照与选中节点时，触发控件全部禁用。 */
    if (selected === undefined || snapshot === null) return
    returnFocus.current = trigger
    setMoreOpen(false)
    setDialogIssue(null)
    setDraft(createDraft(action, selected.node, snapshot.revision))
  }
  const closeMenu = () => {
    setMoreOpen(false)
    moreButton.current?.focus({ preventScroll: true })
  }

  const needsRefresh = draft !== null && (dialogIssue === 'conflict' || dialogIssue === 'refreshFailed'
    || (snapshot !== null && snapshot.revision !== draft.revision))
  const edit = tree === null || draft === null ? null : editFromDraft(tree, draft)
  const waitingForDestination = draft?.action === 'move' && draft.parentId === null
    && tree !== null && moveDestinations(tree, draft.nodeId).length > 0
  const notice = issue === 'missing' ? 'missing'
    : needsRefresh ? dialogIssue === 'refreshFailed' ? 'refreshFailed' : 'conflict'
      : edit === null && !waitingForDestination ? 'targetUnavailable' : dialogIssue

  const refreshDraft = async (current: EditDraft) => {
    const result = await document.refresh()
    if (result === undefined || result.kind === 'missing') return
    if (result.kind === 'ready') {
      setDraft({ ...current, revision: result.snapshot.revision })
      setDialogIssue(null)
    } else {
      setDialogIssue('refreshFailed')
    }
  }
  const submit = async (current: EditDraft) => {
    const target = tree?.byId.get(current.nodeId)
    if (snapshot === null || target === undefined || edit === null || needsRefresh) return
    const result = await document.save(snapshot, edit)
    if (result?.kind === 'conflict') setDialogIssue('conflict')
    if (result?.kind === 'failed') setDialogIssue('saveFailed')
    if (result?.kind !== 'ready') return
    if (edit.op === 'add') {
      const after = indexMindmap(result.snapshot.document.root).byId.get(edit.parentId)?.node.children
      const added = after?.find(child => !target.node.children.some(older => older.id === child.id))
      setSelection(added?.id)
    } else if (edit.op === 'delete') {
      setSelection(target.parent?.node.id)
    }
    setDraft(null)
    setToast(previous => previous + 1)
  }

  return <div className={css.editor}>
    <div className={css.toolbar} role="group" aria-label={t('controls')}>
      <Button ref={addButton} size="sm" variant="primary" icon={<IconPlusOutline16 />} aria-haspopup="dialog"
        disabled={selected === undefined || busy} onClick={(event) => { openDialog('add', event.currentTarget) }}>
        {t('add')}
      </Button>
      <Button size="sm" icon={<IconEditOutline16 />} aria-haspopup="dialog"
        disabled={selected === undefined || busy} onClick={(event) => { openDialog('rename', event.currentTarget) }}>
        {t('rename')}
      </Button>
      <Menu open={menuVisible} portal keyboardNavigation onClose={closeMenu}
        anchor={<Button ref={moreButton} size="sm" className={css.iconButton} icon={<IconEllipsisOutline16 />}
          title={t('more')} aria-label={t('more')} aria-haspopup="menu" aria-expanded={menuVisible}
          disabled={!hasBranch || busy} onClick={() => { setMoreOpen(open => !open) }} />}
        items={branchActions} onSelect={(id) => { openDialog(id as BranchAction, moreButton.current) }} />
      <Button ref={refreshButton} size="sm" className={css.refreshButton} icon={<IconRefreshOutline16 />}
        title={t('refresh')} aria-label={t('refresh')} disabled={busy}
        onClick={() => { void document.refresh() }} />
    </div>
    {issue === 'failed' && tree !== null && <p className={css.syncHint} role="status">{t('pollFailed')}</p>}
    {tree === null || selected === undefined
      ? <div className={css.empty} role={issue === null || activity === 'refresh' ? 'status' : 'alert'}>
        {t(activity === 'refresh' ? 'refreshing' : issue === 'missing' ? 'missing' : issue === 'failed' ? 'loadFailed' : 'loading')}
      </div>
      : <MindmapCanvas tree={tree} selectedId={selected.node.id} onSelect={(id) => {
        setMoreOpen(false)
        setSelection(id)
      }} t={t} />}
    {draft !== null && <MindmapEditDialog draft={draft} tree={tree} t={t} activity={activity}
      notice={notice} needsRefresh={needsRefresh && issue !== 'missing'} canSave={edit !== null && !needsRefresh}
      onChange={setDraft} onRefresh={() => { void refreshDraft(draft) }} onSubmit={() => { void submit(draft) }}
      onClose={() => { setDraft(null) }} />}
    {toast !== 0 && <Toast key={toast} text={t('saved')} onDone={clearToast} />}
  </div>
}
