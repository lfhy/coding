import { Button, Modal } from 'coding-client-ui-primitives'
import type { PropsLocale } from 'coding-client-ui-slots'
import type { NS } from './locales.ts'
import css from './NotesPage.module.css'

interface NoteDeleteDialogProps extends PropsLocale<typeof NS> {
  description: string
  deleting: boolean
  failed: boolean
  onClose: () => void
  onConfirm: () => void
}

/**
 * 删除确认框默认聚焦取消；请求失败时在原弹窗内提示重试。
 * @param props - 目标说明、请求状态与关闭和确认动作。
 * @returns 由笔记页控制生命周期的确认框。
 */
export function NoteDeleteDialog({ t, description, deleting, failed, onClose, onConfirm }: NoteDeleteDialogProps) {
  return (
    <Modal open onClose={onClose} title={t('delete')} closeLabel={t('close')} description={description}
      contentClassName={css.deleteDialogContent ?? ''} trapFocus footer={<>
        <Button variant="outline" autoFocus disabled={deleting} onClick={onClose}>{t('cancel')}</Button>
        <Button variant="primary" className={css.deleteConfirm} disabled={deleting} onClick={onConfirm}>
          {t(deleting ? 'deleting' : 'delete')}
        </Button>
      </>}>
      {failed ? <p className={css.deleteDialogError} role="alert">{t('deleteError')}</p> : undefined}
    </Modal>
  )
}
