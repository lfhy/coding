/** 会话与工作区共用原有重命名弹层；异步提交与关闭策略仍由浏览入口持有。 */
import { useRef } from 'react'
import { Button, Modal } from 'coding-client-ui-primitives'
import type { WorkspaceBrowserProps } from './contract/slots.ts'
import css from './WorkspaceBrowser.module.css'

/**
 * 复用重命名的字段、输入法与提交交互，不复制 Host 业务校验。
 * @param props - 弹层展示值与浏览入口提供的动作。
 * @returns 已有 Modal 风格的重命名表单。
 */
export function WorkspaceRenameDialog({ open, kind, value, busy, blocked, error, duplicate, onChange, onClose, onConfirm, t }: {
  open: boolean
  kind: 'workspace' | 'session'
  value: string
  busy: boolean
  blocked: boolean
  error: string | null
  duplicate?: string | undefined
  onChange: (value: string) => void
  onClose: () => void
  onConfirm: () => void
  t: WorkspaceBrowserProps['t']
}) {
  const composing = useRef(false)
  return (
    <Modal open={open} onClose={onClose} closeLabel={t('close')} title={t(`rename.${kind}.title`)}
      footer={<>
        <Button variant="outline" disabled={busy} onClick={onClose}>{t('cancel')}</Button>
        <Button variant="primary" disabled={blocked} onClick={onConfirm}>{t('rename')}</Button>
      </>}>
      <input className={css.renameInput} value={value} aria-label={t(kind === 'workspace' ? 'field.workspaceName' : 'field.sessionName')}
        autoFocus disabled={busy} onFocus={(event) => { event.target.select() }}
        onChange={(event) => { onChange(event.target.value) }}
        onCompositionStart={() => { composing.current = true }} onCompositionEnd={() => { composing.current = false }}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && !composing.current) {
            event.preventDefault()
            onConfirm()
          }
        }} />
      {duplicate !== undefined && <div className={css.renameError} role="alert">{t('conflict.named', { name: duplicate })}</div>}
      {error !== null && <div className={css.renameError} role="alert">{error}</div>}
    </Modal>
  )
}
