import { useId, useRef, useState } from 'react'
import type { CSSProperties, FormEvent } from 'react'
import {
  Button, IconChevronDownOutline14, IconFolderOpenOutline16, Input, Menu, Modal, type MenuEntry,
} from 'coding-client-ui-primitives'
import type { PropsLocale } from 'coding-client-ui-slots'
import type { NS } from './locales.ts'
import type { NotesTreeEntry } from './wire.ts'
import css from './NotesPage.module.css'

type NameDialogKind = 'create' | 'folder' | 'renameNote' | 'renameFolder'

interface Destination {
  tree: readonly NotesTreeEntry[]
  path: string
  onChange: (path: string) => void
}

interface NoteNameDialogProps extends PropsLocale<typeof NS> {
  kind: NameDialogKind
  name: string
  busy: boolean
  error: string | undefined
  destination: Destination | undefined
  onNameChange: (name: string) => void
  onClose: () => void
  onSubmit: (event: FormEvent<HTMLFormElement>) => void
}

const folderLabel = (path: string) => path.replaceAll('/', ' / ')

function folderEntries(tree: readonly NotesTreeEntry[], rootLabel: string): readonly MenuEntry[] {
  const option = (name: string, path: string, depth: number): MenuEntry => {
    const label = path === '' ? name : folderLabel(path)
    return { id: path, label: (
      <span className={css.locationOption} style={{ '--notes-location-depth': depth } as CSSProperties} title={label}>
        <IconFolderOpenOutline16 aria-hidden />
        <span className={css.locationOptionName} aria-hidden={label !== name || undefined}>{name}</span>
        {label !== name && <span className={css.locationAccessiblePath}>{label}</span>}
      </span>
    ) }
  }
  const entries = [option(rootLabel, '', 0)]
  const append = (nodes: readonly NotesTreeEntry[], depth: number) => {
    for (const node of nodes) {
      if (node.kind !== 'dir') continue
      entries.push(option(node.name, node.path, depth))
      if (node.children !== undefined) append(node.children, depth + 1)
    }
  }
  append(tree, 1)
  return entries
}

/**
 * 新建与重命名共用的名称表单；新建位置由打开入口预选，提交前可在笔记树内更改。
 * @param props - 操作类型、表单值、请求状态与回调。
 * @returns 带名称输入和可选位置菜单的模态框。
 */
export function NoteNameDialog({ t, kind, name, busy, error, destination, onNameChange, onClose, onSubmit }: NoteNameDialogProps) {
  const formId = useId()
  const nameId = useId()
  const locationId = useId()
  const locationLabelId = useId()
  const locationValueId = useId()
  const locationTrigger = useRef<HTMLButtonElement>(null)
  const [locationsOpen, setLocationsOpen] = useState(false)
  const closeLocations = () => {
    setLocationsOpen(false)
    locationTrigger.current?.focus({ preventScroll: true })
  }
  const renaming = kind === 'renameNote' || kind === 'renameFolder'
  const root = t('allNotes')
  const location = destination === undefined || destination.path === '' ? root : folderLabel(destination.path)
  return (
    <Modal open onClose={locationsOpen ? closeLocations : onClose} trapFocus
      title={t(kind === 'create' ? 'newNote' : kind === 'folder' ? 'newFolder' : kind)} closeLabel={t('close')}
      footer={<>
        <Button variant="outline" disabled={busy} onClick={onClose}>{t('cancel')}</Button>
        <Button variant="primary" type="submit" form={formId} disabled={busy || name.trim() === ''}>
          {t(renaming ? busy ? 'renaming' : 'rename' : busy ? 'creating' : 'create')}
        </Button>
      </>}>
      <form id={formId} className={css.form} onSubmit={onSubmit}>
        <label htmlFor={nameId}>{t(kind === 'folder' || kind === 'renameFolder' ? 'folderName' : 'noteName')}</label>
        <Input id={nameId} value={name} autoFocus readOnly={busy}
          onChange={(event) => { onNameChange(event.target.value) }} />
        {destination !== undefined && <div className={css.locationField}>
          <label id={locationLabelId} htmlFor={locationId}>{t('saveLocation')}</label>
          <Menu open={locationsOpen} items={locationsOpen ? folderEntries(destination.tree, root) : []}
            keyboardNavigation portal matchAnchorWidth dense maxHeight={224} selectedId={destination.path}
            portalContainer={locationTrigger.current?.closest('[role="dialog"]') ?? null}
            onClose={closeLocations} onSelect={(path) => { destination.onChange(path); closeLocations() }}
            anchor={<Button ref={locationTrigger} id={locationId} variant="outline" className={css.locationButton}
              icon={<IconFolderOpenOutline16 />} aria-labelledby={`${locationLabelId} ${locationValueId}`}
              aria-haspopup="menu" aria-expanded={locationsOpen} disabled={busy}
              onClick={() => { setLocationsOpen(open => !open) }}>
              <span id={locationValueId} className={css.locationValue} title={location}>{location}</span>
              <IconChevronDownOutline14 />
            </Button>} />
        </div>}
        {error !== undefined && <p className={css.formError} role="alert">{error}</p>}
      </form>
    </Modal>
  )
}
