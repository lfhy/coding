/** 复用共享表单、菜单与模态框，保留冲突后的当前输入。 */
import { useId, useLayoutEffect, useRef, useState } from 'react'
import clsx from 'clsx'
import { Button, IconChevronDownOutline14, Input, Menu, Modal } from 'coding-client-ui-primitives'
import type { PropsLocale } from 'coding-client-ui-slots'
import type { MindmapLocaleKey, NS } from './locales.ts'
import type { BranchAction, EditDraft } from './mindmap-edits.ts'
import { moveDestinations, nodeTrail, type MindmapTree } from './mindmap-tree.ts'
import type { MindmapNodeId } from './wire.ts'
import css from './MindmapEditor.module.css'

interface DialogProps extends PropsLocale<typeof NS> {
  draft: EditDraft
  tree: MindmapTree | null
  notice: MindmapLocaleKey | null
  needsRefresh: boolean
  activity: 'refresh' | 'save' | null
  canSave: boolean
  onChange: (draft: EditDraft) => void
  onRefresh: () => void
  onSubmit: () => void
  onClose: () => void
}

const DESCRIPTION: Record<BranchAction, MindmapLocaleKey> = {
  add: 'addTo', rename: 'renameCurrent', move: 'moveConfirm', earlier: 'earlierConfirm', later: 'laterConfirm', delete: 'deleteConfirm',
}

/**
 * 显示一项编辑的输入或确认；版本冲突在原对话框中刷新。
 * @param props - 草稿、可用目标、当前请求和表单动作。
 * @returns 已聚焦的短表单或确认框。
 */
export function MindmapEditDialog({ draft, tree, notice, needsRefresh, activity, canSave,
  onChange, onRefresh, onSubmit, onClose, t }: DialogProps) {
  const formId = useId()
  const fieldId = useId()
  const noticeId = useId()
  const destinationTrigger = useRef<HTMLButtonElement>(null)
  const cancelButton = useRef<HTMLButtonElement>(null)
  const saveButton = useRef<HTMLButtonElement>(null)
  const refreshButton = useRef<HTMLButtonElement>(null)
  const [picker, setPicker] = useState<Element | null>(null)
  const target = tree?.byId.get(draft.nodeId)?.node
  const busy = activity !== null
  const editingText = draft.action === 'add' || draft.action === 'rename'
  const moving = draft.action === 'move'
  const choices = moving && tree !== null ? moveDestinations(tree, draft.nodeId) : []
  const selectedChoice = moving ? choices.find(row => row.node.id === draft.parentId) : undefined
  const closePicker = () => {
    setPicker(null)
    destinationTrigger.current?.focus({ preventScroll: true })
  }
  const close = () => {
    if (busy) return
    if (picker !== null) closePicker()
    else onClose()
  }
  const hasChoice = choices.length > 0
  const description = target === undefined ? undefined : t(DESCRIPTION[draft.action], {
    name: target.text.trim() === '' ? t('unnamed') : target.text,
  })

  useLayoutEffect(() => {
    // 不抢走正在输入的焦点；只接回因提交按钮禁用或刷新按钮消失而失去的焦点。
    const active = document.activeElement
    if (busy || (active !== document.body && (active !== saveButton.current || canSave))) return
    const next = needsRefresh ? refreshButton.current : canSave ? saveButton.current : cancelButton.current
    next?.focus({ preventScroll: true })
  }, [busy, canSave, needsRefresh])

  return <Modal open trapFocus onClose={close} title={t(draft.action)} closeLabel={t('close')}
    {...description === undefined ? {} : { description }}
    className={clsx(css.dialog)} contentClassName={clsx(css.dialogContent)} footer={<>
      <Button ref={cancelButton} variant="outline" autoFocus={!editingText && (!moving || !hasChoice)} disabled={busy} onClick={close}>
        {t('cancel')}
      </Button>
      <Button ref={saveButton} type="submit" form={formId} variant="primary"
        className={draft.action === 'delete' ? css.deleteConfirm : undefined}
        disabled={busy || !canSave}>
        {t(activity === 'save' ? 'saving' : draft.action === 'add' || draft.action === 'delete' ? draft.action : 'confirm')}
      </Button>
    </>}>
    <form id={formId} className={css.form} aria-busy={busy} onSubmit={(event) => { event.preventDefault(); onSubmit() }}>
      {editingText && <>
        <label htmlFor={fieldId} className={css.label}>{t('text')}</label>
        <Input id={fieldId} autoFocus disabled={busy} value={draft.text} aria-describedby={notice === null ? undefined : noticeId}
          onChange={(event) => { onChange({ ...draft, text: event.target.value }) }} />
      </>}
      {moving && <>
        <label htmlFor={fieldId} className={css.label}>{t('destination')}</label>
        <Menu open={picker !== null && hasChoice} portal portalContainer={picker} matchAnchorWidth
          maxHeight={248} keyboardNavigation onClose={closePicker} className={clsx(css.destinationMenu)}
          anchor={<Button id={fieldId} ref={destinationTrigger} autoFocus={hasChoice}
            className={css.destinationTrigger} variant="outline" aria-haspopup="menu"
            aria-expanded={picker !== null && hasChoice} aria-describedby={notice === null ? undefined : noticeId}
            disabled={busy || !hasChoice} onClick={(event) => {
              if (picker === null) setPicker(event.currentTarget.closest('[role="dialog"]'))
              else closePicker()
            }}>
            <span className={css.optionText}>{selectedChoice === undefined
              ? t('chooseDestination') : nodeTrail(selectedChoice, t('unnamed'))}</span>
            <IconChevronDownOutline14 />
          </Button>}
          selectedId={selectedChoice?.node.id} highlightSelected
          items={choices.map((row) => {
            const title = nodeTrail(row, t('unnamed'))
            return { id: row.node.id, label: <span className={css.optionText} title={title}>{title}</span> }
          })}
          onSelect={(id) => {
            // 菜单仅返回上面候选项已有的标识；保存仍按新快照核对目标。
            onChange({ ...draft, parentId: id as MindmapNodeId })
            closePicker()
          }} />
      </>}
      {notice !== null && <p id={noticeId} className={css.notice} role="alert">{t(notice)}</p>}
      {needsRefresh && <Button ref={refreshButton} className={css.recoverButton} size="sm" variant="outline" disabled={busy} onClick={onRefresh}>
        {t(activity === 'refresh' ? 'refreshing' : 'refresh')}
      </Button>}
    </form>
  </Modal>
}
