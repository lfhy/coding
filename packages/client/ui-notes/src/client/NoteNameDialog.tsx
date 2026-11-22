import { useEffect, useId, useRef, useState } from 'react'
import type { CSSProperties, FormEvent } from 'react'
import {
  Button, IconChevronDownOutline14, IconFolderOpenOutline16, IconProjectAddOutline16, Input, Menu, Modal, type MenuEntry,
} from 'coding-client-ui-primitives'
import type { PropsLocale } from 'coding-client-ui-slots'
import type { NS } from './locales.ts'
import type { NoteCreateKind } from './NotesDirectory.tsx'
import type { NotesTreeEntry } from './wire.ts'
import css from './NotesPage.module.css'

type NameDialogKind = NoteCreateKind | 'renameNote' | 'renameFolder' | 'renamePresentation' | 'renameMindmap'

interface Destination {
  tree: readonly NotesTreeEntry[]
  path: string
  onChange: (path: string) => void
  onCreateDirectory: (name: string, parent: string) => Promise<string | undefined>
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
const SELECT_DIRECTORY = 'directory:'
const CREATE_DIRECTORY = 'create-directory:'

function folderEntries(tree: readonly NotesTreeEntry[], rootLabel: string, actionLabel: (name: string) => string): readonly MenuEntry[] {
  const option = (name: string, path: string, depth: number): MenuEntry => {
    const label = path === '' ? name : folderLabel(path)
    return { id: `${SELECT_DIRECTORY}${path}`, action: {
      id: `${CREATE_DIRECTORY}${path}`, label: actionLabel(label), icon: <IconProjectAddOutline16 />,
    }, label: (
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
  const lifetime = useRef<AbortController | null>(null)
  const returnToLocation = useRef(false)
  const [locationsOpen, setLocationsOpen] = useState(false)
  const [subfolder, setSubfolder] = useState<{ parent: string; name: string; failed: boolean } | null>(null)
  useEffect(() => {
    const controller = new AbortController()
    lifetime.current = controller
    return () => { controller.abort() }
  }, [])
  useEffect(() => {
    if (subfolder !== null || !returnToLocation.current) return
    returnToLocation.current = false
    locationTrigger.current?.focus({ preventScroll: true })
  }, [subfolder])
  const closeLocations = () => {
    setLocationsOpen(false)
    locationTrigger.current?.focus({ preventScroll: true })
  }
  const renaming = kind.startsWith('rename')
  const root = t('allNotes')
  const location = destination === undefined || destination.path === '' ? root : folderLabel(destination.path)
  const returnFromSubfolder = () => {
    returnToLocation.current = true
    setSubfolder(null)
  }
  const close = () => {
    if (busy) return
    if (locationsOpen) closeLocations()
    else if (subfolder !== null) returnFromSubfolder()
    else onClose()
  }
  const createSubfolder = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (subfolder === null || destination === undefined || busy || subfolder.name.trim() === '') return
    const signal = lifetime.current?.signal
    setSubfolder({ ...subfolder, failed: false })
    try {
      const path = await destination.onCreateDirectory(subfolder.name.trim(), subfolder.parent)
      if (signal?.aborted === true || path === undefined) return
      returnFromSubfolder()
    } catch {
      if (signal?.aborted !== true) setSubfolder({ ...subfolder, failed: true })
    }
  }
  const fieldName = subfolder?.name ?? name
  const formError = subfolder === null ? error : subfolder.failed ? t('createFolderError') : undefined
  return (
    <Modal open onClose={close} trapFocus
      title={t(subfolder !== null ? 'newSubfolder' : titleKeys[kind])}
      {...(subfolder === null ? {} : { description: t('newFolderIn', { name: subfolder.parent === '' ? root : folderLabel(subfolder.parent) }) })}
      closeLabel={t('close')}
      footer={<>
        <Button variant="outline" disabled={busy} onClick={subfolder === null ? onClose : returnFromSubfolder}>{t('cancel')}</Button>
        <Button variant="primary" type="submit" form={formId} disabled={busy || fieldName.trim() === ''}>
          {t(renaming && subfolder === null ? busy ? 'renaming' : 'rename' : busy ? 'creating' : 'create')}
        </Button>
      </>}>
      <form id={formId} className={css.form} onSubmit={subfolder === null ? onSubmit : (event) => { void createSubfolder(event) }}>
        <label htmlFor={nameId}>{t(subfolder === null ? nameKeys[kind] : 'folderName')}</label>
        <Input key={subfolder === null ? 'entry' : 'subfolder'} id={nameId} value={fieldName} autoFocus readOnly={busy}
          onChange={(event) => {
            if (subfolder === null) onNameChange(event.target.value)
            else setSubfolder({ ...subfolder, name: event.target.value, failed: false })
          }} />
        {destination !== undefined && subfolder === null && <div className={css.locationField}>
          <label id={locationLabelId} htmlFor={locationId}>{t('saveLocation')}</label>
          <Menu open={locationsOpen} items={locationsOpen
            ? folderEntries(destination.tree, root, name => t('newSubfolderIn', { name })) : []}
          keyboardNavigation portal matchAnchorWidth dense maxHeight={224} selectedId={`${SELECT_DIRECTORY}${destination.path}`}
          portalContainer={locationTrigger.current?.closest('[role="dialog"]') ?? null}
          onClose={closeLocations} onSelect={(id) => {
            if (id.startsWith(CREATE_DIRECTORY)) {
              setLocationsOpen(false)
              setSubfolder({ parent: id.slice(CREATE_DIRECTORY.length), name: '', failed: false })
            } else {
              destination.onChange(id.slice(SELECT_DIRECTORY.length))
              closeLocations()
            }
          }}
          anchor={<Button ref={locationTrigger} id={locationId} variant="outline" className={css.locationButton}
            icon={<IconFolderOpenOutline16 />} aria-labelledby={`${locationLabelId} ${locationValueId}`}
            aria-haspopup="menu" aria-expanded={locationsOpen} disabled={busy}
            onClick={() => { setLocationsOpen(open => !open) }}>
            <span id={locationValueId} className={css.locationValue} title={location}>{location}</span>
            <IconChevronDownOutline14 />
          </Button>} />
        </div>}
        {formError !== undefined && <p className={css.formError} role="alert">{formError}</p>}
      </form>
    </Modal>
  )
}

const titleKeys = {
  create: 'newNote', folder: 'newFolder', presentation: 'newPresentation', mindmap: 'newMindmap',
  renameNote: 'renameNote', renameFolder: 'renameFolder', renamePresentation: 'renamePresentation', renameMindmap: 'renameMindmap',
} as const

const nameKeys = {
  create: 'noteName', folder: 'folderName', presentation: 'presentationName', mindmap: 'mindmapName',
  renameNote: 'noteName', renameFolder: 'folderName', renamePresentation: 'presentationName', renameMindmap: 'mindmapName',
} as const
