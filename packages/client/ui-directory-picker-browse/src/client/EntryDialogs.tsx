/**
 * 目录浏览器的三个嵌套拟态框：新建文件夹、重命名、删除。三者都是受控纯展示
 * 组件——草稿、忙碌、错误文本都由持有者给出，框内只负责输入、IME 守卫与
 * Escape/Enter 语义。删除框的主按钮是破坏性样式，且只有操作者在这里确认之后，
 * 持有者才允许调用删除原语。
 */
import { useRef } from 'react'
import type { ReactNode } from 'react'
import clsx from 'clsx'
import type { Translate } from 'coding-client-locale/client'
import { Button, Input, Modal } from 'coding-client-ui-primitives'
import css from './DirectoryBrowser.module.css'

/** 重命名草稿的问题：空白、含分隔符，或没有（可以提交）。 */
export type RenameDraftError = 'blank' | 'separator' | null

/**
 * 重命名草稿校验：名称必须非空，且不含 `/` 或 `\`（跨平台都不允许成为同一层
 * 的名字）。只做前端栅栏，Host 后端仍会重复同一条校验。
 * @param draft - 输入框里的新名称。
 * @returns 问题分类或 null。
 */
export function renameDraftError(draft: string): RenameDraftError {
  if (draft.trim() === '') return 'blank'
  return /[/\\]/.test(draft) ? 'separator' : null
}

/** IME 守卫：Enter 选中候选词时不得提交，与路径编辑器同一处理。 */
function useImeGuard() {
  const composing = useRef(false)
  return {
    composing,
    guard: {
      onCompositionStart: () => { composing.current = true },
      onCompositionEnd: () => { composing.current = false },
    },
  }
}

/** 嵌套拟态框共用外壳：小卡片、标题、正文与右对齐的按钮行。 */
function EntryDialog({ open, title, busy, error, onCancel, children }: {
  open: boolean
  title: string
  busy: boolean
  error: string | null
  onCancel: () => void
  children: ReactNode
}) {
  return (
    <Modal
      open={open}
      // 忙碌时关不掉：请求已经发出，关掉只会让结果无处可比对。
      onClose={() => { if (!busy) onCancel() }}
      title={title}
      className={clsx(css.entryDialog)}
      headless
    >
      <div className={css.entryBody}>
        <h3 className={css.entryTitle}>{title}</h3>
        {children}
        {error !== null && <div className={css.error} role="alert">{error}</div>}
      </div>
    </Modal>
  )
}

/** 新建文件夹拟态框的 props。 */
export interface CreateFolderDialogProps {
  /** 框是否打开。 */
  open: boolean
  /** 目标目录名（正文里点名建在哪里）。 */
  targetName: string
  /** 当前草稿。 */
  value: string
  /** 创建请求在跑：输入与按钮全部禁用。 */
  busy: boolean
  /** Host 失败文本。 */
  error: string | null
  /** 草稿变化。 */
  onChange: (value: string) => void
  /** 取消（不产生请求）。 */
  onCancel: () => void
  /** 提交一个非空白草稿。 */
  onConfirm: () => void
  /** 本地化文案。 */
  t: Translate
}

/** 新建文件夹：在目标目录里创建一层新目录。 */
export function CreateFolderDialog({
  open, targetName, value, busy, error, onChange, onCancel, onConfirm, t,
}: CreateFolderDialogProps) {
  const { composing, guard } = useImeGuard()
  return (
    <EntryDialog open={open} title={t('browser.newFolder')} busy={busy} error={error} onCancel={onCancel}>
      <p className={css.entryIn}>{t('browser.createIn', { name: targetName })}</p>
      <Input
        className={clsx(css.entryInput)}
        value={value}
        aria-label={t('browser.folderName')}
        placeholder={t('browser.untitledFolder')}
        autoFocus
        disabled={busy}
        onChange={(event) => { onChange(event.target.value) }}
        {...guard}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && !composing.current) {
            event.preventDefault()
            onConfirm()
          }
          if (event.key === 'Escape') {
            event.stopPropagation()
            if (!busy) onCancel()
          }
        }}
      />
      <div className={css.entryActions}>
        <Button variant="outline" disabled={busy} onClick={onCancel}>{t('browser.cancel')}</Button>
        <Button variant="primary" disabled={busy || value.trim() === ''} onClick={onConfirm}>{t('browser.create')}</Button>
      </div>
    </EntryDialog>
  )
}

/** 重命名拟态框的 props。 */
export interface RenameDialogProps {
  /** 框是否打开。 */
  open: boolean
  /** 被重命名条目当前的名称（预填值由父级通过 `value` 给出）。 */
  entryName: string
  /** 当前草稿。 */
  value: string
  /** 改名请求在跑。 */
  busy: boolean
  /** Host 失败文本，留在框内。 */
  error: string | null
  /** 草稿变化。 */
  onChange: (value: string) => void
  /** 取消（不产生请求）。 */
  onCancel: () => void
  /** 提交一个通过校验的草稿。 */
  onConfirm: () => void
  /** 本地化文案。 */
  t: Translate
}

/** 重命名：同一个父目录下改名，成功后由持有者刷新层级。 */
export function RenameDialog({
  open, entryName, value, busy, error, onChange, onCancel, onConfirm, t,
}: RenameDialogProps) {
  const { composing, guard } = useImeGuard()
  const invalid = renameDraftError(value)
  const validation = invalid === 'blank'
    ? t('browser.renameRequired')
    : invalid === 'separator' ? t('browser.renameNoSeparator') : null
  const submit = (): void => {
    if (invalid !== null) return
    onConfirm()
  }
  return (
    <EntryDialog open={open} title={t('browser.renameTitle')} busy={busy} error={error} onCancel={onCancel}>
      <p className={css.entryIn}>{t('browser.renameFor', { name: entryName })}</p>
      <Input
        className={clsx(css.entryInput)}
        value={value}
        aria-label={t('browser.renameLabel')}
        autoFocus
        disabled={busy}
        onChange={(event) => { onChange(event.target.value) }}
        {...guard}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && !composing.current) {
            event.preventDefault()
            submit()
          }
          if (event.key === 'Escape') {
            event.stopPropagation()
            if (!busy) onCancel()
          }
        }}
      />
      {/* 校验失败留在框内，与 Host 失败同一个 role="alert" 通道。 */}
      {validation !== null && <div className={css.error} role="alert">{validation}</div>}
      <div className={css.entryActions}>
        <Button variant="outline" disabled={busy} onClick={onCancel}>{t('browser.cancel')}</Button>
        <Button variant="primary" disabled={busy || invalid !== null} onClick={submit}>{t('browser.save')}</Button>
      </div>
    </EntryDialog>
  )
}

/** 删除确认拟态框的 props。 */
export interface DeleteDialogProps {
  /** 框是否打开。 */
  open: boolean
  /** 被删除条目名称。 */
  entryName: string
  /** 目标是目录：正文额外写明会连内容一起删掉。 */
  isDirectory: boolean
  /** 删除请求在跑。 */
  busy: boolean
  /** Host 失败文本，留在框内。 */
  error: string | null
  /** 取消（不产生请求）。 */
  onCancel: () => void
  /** 操作者确认删除。 */
  onConfirm: () => void
  /** 本地化文案。 */
  t: Translate
}

/**
 * 删除确认：破坏性操作必须在这里被明确确认；取消、Escape、点击遮罩都不产生
 * 任何写操作。
 */
export function DeleteDialog({
  open, entryName, isDirectory, busy, error, onCancel, onConfirm, t,
}: DeleteDialogProps) {
  return (
    <EntryDialog open={open} title={t('browser.deleteTitle')} busy={busy} error={error} onCancel={onCancel}>
      <p className={css.entryIn}>{t('browser.deleteBody', { name: entryName })}</p>
      {isDirectory && <p className={css.entryWarning}>{t('browser.deleteDirBody')}</p>}
      <div className={css.entryActions}>
        <Button variant="outline" disabled={busy} onClick={onCancel}>{t('browser.cancel')}</Button>
        <Button
          variant="primary"
          className={css.dangerAction}
          disabled={busy}
          onClick={onConfirm}
        >
          {t('browser.deleteConfirm')}
        </Button>
      </div>
    </EntryDialog>
  )
}
