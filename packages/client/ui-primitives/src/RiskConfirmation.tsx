/** 供敏感操作界面共用的受控风险确认框，必须显式勾选后才能继续。 */
import { Button } from './Button.tsx'
import { IconWarningOutline16 } from '@deepseek-ai/dsh-client-ui-icons'
import { Modal } from './Modal.tsx'
import css from './RiskConfirmation.module.css'

export interface RiskConfirmationProps {
  open: boolean
  title: string
  description: string
  acknowledgeLabel: string
  closeLabel?: string
  cancelLabel: string
  confirmLabel: string
  acknowledged: boolean
  disabled?: boolean
  onAcknowledgedChange: (acknowledged: boolean) => void
  onCancel: () => void
  onConfirm: () => void
}

/** 渲染页面内确认框；调用方控制的确认项勾选前，主要动作保持不可用。 */
export function RiskConfirmation({
  open,
  title,
  description,
  acknowledgeLabel,
  closeLabel = 'Close',
  cancelLabel,
  confirmLabel,
  acknowledged,
  disabled = false,
  onAcknowledgedChange,
  onCancel,
  onConfirm,
}: RiskConfirmationProps) {
  return (
    <Modal
      open={open}
      onClose={onCancel}
      title={title}
      closeLabel={closeLabel}
      className={css.confirmation ?? ''}
      contentClassName={css.confirmationContent ?? ''}
      footer={(
        <>
          <Button variant="outline" className={css.modalAction} onClick={onCancel}>
            {cancelLabel}
          </Button>
          <Button
            variant="primary"
            className={css.confirmAction}
            disabled={disabled || !acknowledged}
            onClick={onConfirm}
          >
            {confirmLabel}
          </Button>
        </>
      )}
    >
      <div className={css.warning}>
        <IconWarningOutline16 size={18} className={css.warningIcon} />
        <p>{description}</p>
      </div>
      <label className={css.acknowledgement}>
        <input
          type="checkbox"
          checked={acknowledged}
          disabled={disabled}
          autoFocus
          onChange={(event) => { onAcknowledgedChange(event.currentTarget.checked) }}
        />
        <span>{acknowledgeLabel}</span>
      </label>
    </Modal>
  )
}
