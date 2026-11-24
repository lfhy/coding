/** 可见路径拥有一套编辑器、操作工具栏和共享弹层。 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react'
import { Button, IconDownloadOutline16, Modal, StateDot, Toast, type StateDotState } from 'coding-client-ui-primitives'
import type { PropsLocale, PropsRuntime, PropsStore } from 'coding-client-ui-slots'
import { createOfficeDocumentController, type OfficeDraft, type OfficeSeed, type OfficeView } from './document-controller.ts'
import type { createOfficeDraftStore } from './drafts.ts'
import { FormatToolbar } from './FormatToolbar.tsx'
import { isOfficeDocument, type OfficeKind } from './office-document.ts'
import type { NS, OfficeLocaleKey } from './locales.ts'
import { createOfficeEngine, type OfficeEngine, type OfficeFormat } from './univer-engine.ts'
import { createOfficeIo, downloadOffice } from './wire.ts'
import css from './OfficeEditor.module.css'

type SlotProps = PropsRuntime<'notes.document.office'> & PropsLocale<typeof NS> & PropsStore<ReturnType<typeof createOfficeDraftStore>>
type Controller = ReturnType<typeof createOfficeDocumentController>
type BodyProps = Pick<SlotProps, 'path' | 'kind' | 't'> & {
  initial: OfficeDraft | undefined
  retain: (draft: OfficeDraft | undefined) => void
}

const POLL_MS = 4_000
const DOT: Record<OfficeView['status'], StateDotState> = {
  loading: 'ongoing', loadFailed: 'error', saved: 'done', dirty: 'warning', saving: 'ongoing', saveFailed: 'error',
  missing: 'error', conflict: 'warning', unsupported: 'warning',
}

/**
 * 笔记正文只在当前类型可见时启动编辑器；改名、切页或隐去都会切断旧请求。
 * @param props - 笔记内容座位、词典和会话草稿。
 * @returns 当前笔记正文或隐藏时的空内容。
 */
export function OfficeEditor({ path, kind, shown, sessionId, t, useStore, actions }: SlotProps) {
  const key = JSON.stringify([kind, path])
  const initial = useStore(state => state.drafts[key])
  const retain = useCallback((draft: OfficeDraft | undefined) => { actions.retain(key, draft) }, [actions, key])
  return shown
    ? <OfficeBody key={JSON.stringify([sessionId, key])} path={path} kind={kind} t={t} initial={initial} retain={retain} />
    : null
}

type CanvasOwner = {
  engine: OfficeEngine
  capture(): boolean
}

function useOfficeCanvas(seed: OfficeSeed | null, kind: OfficeKind, onEdit: Controller['edit']) {
  const container = useRef<HTMLDivElement>(null)
  const owner = useRef<CanvasOwner | null>(null)
  const [retry, setRetry] = useState(0)
  const [loaded, setLoaded] = useState<{ seed: OfficeSeed; ready: boolean } | null>(null)

  useEffect(() => {
    if (seed === null || container.current === null) return
    const abort = new AbortController()
    let engine: OfficeEngine | undefined
    const onChange = () => { owner.current?.capture() }
    void createOfficeEngine({ container: container.current, document: seed.document, signal: abort.signal, onChange }).then((opened) => {
      if (abort.signal.aborted) { opened.dispose(); return }
      engine = opened
      let previous = JSON.stringify(opened.read())
      let unsupported = false
      owner.current = {
        engine: opened,
        capture: () => {
          try {
            const current = opened.read()
            if (!isOfficeDocument(current, kind)) throw new Error('Unrepresentable document')
            const fingerprint = JSON.stringify(current)
            if (unsupported || previous !== fingerprint) onEdit(current)
            previous = fingerprint
            unsupported = false
            return true
          } catch {
            unsupported = true
            onEdit(null)
            return false
          }
        },
      }
      setLoaded({ seed, ready: true })
    }).catch(() => {
      if (!abort.signal.aborted) {
        engine?.dispose()
        setLoaded({ seed, ready: false })
      }
    })
    return () => {
      abort.abort()
      owner.current = null
      // 独立的编辑根不能在外层 React 正在退出提交时同步卸载。
      queueMicrotask(() => { engine?.dispose() })
    }
  }, [seed, kind, onEdit, retry])

  return {
    container, owner,
    ready: seed !== null && loaded?.seed === seed && loaded.ready,
    failed: seed !== null && loaded?.seed === seed && !loaded.ready,
    retry: () => { setLoaded(null); setRetry(value => value + 1) },
  }
}

function OfficeBody({ path, kind, initial, retain, t }: BodyProps) {
  const controller = useRef<Controller | null>(null)
  const mounted = useRef({ initial, retain })
  const [view, setView] = useState<OfficeView>({ seed: null, status: 'loading', conflict: false })
  const onEdit = useCallback<Controller['edit']>((document) => { controller.current?.edit(document) }, [])
  const canvas = useOfficeCanvas(view.seed, kind, onEdit)
  const [dialog, setDialog] = useState<'export' | 'conflict' | null>(null)
  const [pending, setPending] = useState(false)
  const [reviewed, setReviewed] = useState(false)
  const [notice, setNotice] = useState<OfficeLocaleKey | null>(null)
  const [toast, setToast] = useState<{ key: OfficeLocaleKey; id: number } | null>(null)
  const toastId = useRef(0)
  const dialogEpoch = useRef(0)
  const exportButton = useRef<HTMLButtonElement>(null)
  const imagePicker = useRef<HTMLInputElement>(null)
  const resolveButton = useRef<HTMLButtonElement>(null)
  const saveButton = useRef<HTMLButtonElement>(null)

  useLayoutEffect(() => {
    const scope = createOfficeDocumentController({
      io: createOfficeIo(path, kind), initial: mounted.current.initial, retain: mounted.current.retain, publish: setView,
      isEditing: () => canvas.owner.current?.engine.isEditing() ?? false,
    })
    controller.current = scope
    void scope.open()
    const poll = () => { if (document.visibilityState !== 'hidden') void scope.poll() }
    const interval = setInterval(poll, POLL_MS)
    document.addEventListener('visibilitychange', poll)
    return () => {
      clearInterval(interval)
      document.removeEventListener('visibilitychange', poll)
      // 最后一个已提交的画布变更可能还在等待微任务；切换时先将它保留到原路径。
      canvas.owner.current?.capture()
      scope.dispose()
      controller.current = null
    }
  }, [path, kind, canvas.owner])

  const showToast = (key: OfficeLocaleKey) => { setToast({ key, id: ++toastId.current }) }
  const live = (scope: Controller | null) => scope !== null && scope === controller.current
  const closeDialog = (focus: HTMLButtonElement | null) => {
    ++dialogEpoch.current
    setDialog(null)
    setPending(false)
    setNotice(null)
    requestAnimationFrame(() => { (focus?.isConnected ? focus : saveButton.current)?.focus({ preventScroll: true }) })
  }
  const flush = async (): Promise<boolean> => {
    const owner = canvas.owner.current
    if (owner === null) return false
    try {
      return await owner.engine.finishEditing() && owner === canvas.owner.current && owner.capture()
    } catch {
      if (owner === canvas.owner.current) onEdit(null)
      return false
    }
  }
  const review = async (scope: Controller, epoch: number) => {
    setReviewed(false)
    setNotice(null)
    setPending(true)
    const result = await scope.review()
    if (!live(scope) || dialogEpoch.current !== epoch) return
    setReviewed(result === 'ready')
    setNotice(result === 'ready' ? null : result === 'missing' ? 'missing' : 'reviewFailed')
    setPending(false)
  }
  const openConflict = () => {
    const scope = controller.current
    if (scope === null) return
    setDialog('conflict')
    void review(scope, ++dialogEpoch.current)
  }
  const save = async () => {
    const scope = controller.current
    if (!canvas.ready || scope === null || !await flush() || !live(scope)) return
    const result = await scope.save()
    if (!live(scope)) return
    if (result === 'ready') showToast('saved')
    else if (result === 'conflict') openConflict()
  }
  const replace = async () => {
    const scope = controller.current
    if (scope === null || pending || !reviewed || !await flush() || !live(scope)) return
    const epoch = dialogEpoch.current
    setNotice(null)
    setPending(true)
    const result = await scope.replaceLatest()
    if (!live(scope) || epoch !== dialogEpoch.current) return
    setPending(false)
    if (result === 'ready') {
      closeDialog(resolveButton.current)
      showToast('saved')
    } else if (result === 'conflict') {
      setReviewed(false)
      setNotice('conflict')
    } else setNotice(result === 'missing' ? 'missing' : 'saveFailed')
  }
  const exportDocument = async () => {
    const scope = controller.current
    if (scope === null || pending) return
    const epoch = dialogEpoch.current
    setPending(true)
    setNotice(null)
    const flushed = await flush()
    if (!live(scope) || epoch !== dialogEpoch.current) return
    if (!flushed) {
      setNotice('unsupported')
      setPending(false)
      return
    }
    const result = await scope.export()
    if (!live(scope) || epoch !== dialogEpoch.current) return
    setPending(false)
    if (result.kind === 'ready') {
      try {
        downloadOffice(result.value)
        closeDialog(exportButton.current)
        showToast('exported')
      } catch { setNotice('exportFailed') }
    } else if (result.kind !== 'cancelled') {
      setNotice(result.kind === 'conflict' ? 'exportConflict' : result.kind === 'failed' ? 'exportFailed' : result.kind)
    }
  }
  const format = async (action: OfficeFormat) => {
    const owner = canvas.owner.current
    if (owner === null) return
    try {
      const ok = await owner.engine.format(action)
      if (canvas.owner.current !== owner) return
      if (ok) owner.capture()
      else if (action.key !== 'undo' && action.key !== 'redo') showToast('formatFailed')
    } catch {
      if (canvas.owner.current === owner) showToast('formatFailed')
    }
  }
  /** 图片按行内对象插入当前选区；失败时提示而不是静默丢弃。 */
  const insertImage = async (image: File) => {
    const owner = canvas.owner.current
    if (owner === null) return
    try {
      const ok = await owner.engine.insertImage(image)
      if (canvas.owner.current !== owner) return
      if (ok) owner.capture()
      else showToast('imageFailed')
    } catch {
      if (canvas.owner.current === owner) showToast('imageFailed')
    }
  }
  const shortcut = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key.toLowerCase() !== 's' || !(event.metaKey || event.ctrlKey)) return
    event.preventDefault()
    event.stopPropagation()
    if (dialog === null && !event.repeat && view.status !== 'saving') void save()
  }
  const ready = canvas.ready
  const conflict = view.conflict
  const blocked = view.status === 'unsupported' || view.status === 'missing'
  const name = t(kind === 'word' ? 'wordEditor' : 'excelEditor')

  return <div className={css.editor} data-note-office-editor={kind} onKeyDownCapture={shortcut}>
    <div className={css.toolbar} role="group" aria-label={t('controls')}>
      <span className={css.saveState} role="status"><StateDot state={DOT[view.status]} />{t(view.status)}</span>
      <div className={css.actions}>
        {conflict && <Button ref={resolveButton} size="sm" variant="outline" aria-haspopup="dialog" onClick={openConflict}>{t('resolve')}</Button>}
        <Button ref={saveButton} size="sm" disabled={!ready || blocked || view.status === 'saving'} onClick={() => { void save() }}>{t('save')}</Button>
        <Button ref={exportButton} size="sm" variant="outline" icon={<IconDownloadOutline16 />} aria-haspopup="dialog"
          disabled={!ready || blocked || conflict} onClick={() => { ++dialogEpoch.current; setNotice(null); setDialog('export') }}>{t('export')}</Button>
      </div>
    </div>
    <FormatToolbar kind={kind} disabled={!ready} t={t} format={(action) => { void format(action) }}
      insertImage={() => { imagePicker.current?.click() }} />
    <input ref={imagePicker} type="file" accept="image/*" hidden aria-hidden tabIndex={-1}
      onChange={(event) => {
        const image = event.target.files?.[0]
        event.target.value = ''
        if (image !== undefined) void insertImage(image)
      }} />
    <section className={css.canvas} aria-label={name} aria-busy={view.status === 'loading' || (view.seed !== null && !ready && !canvas.failed)}>
      <div ref={canvas.container} className={css.engine} />
      {view.seed === null && (view.status === 'loadFailed' || view.status === 'missing') && <div className={css.empty}>
        <Button size="sm" onClick={() => { void controller.current?.open() }}>{t('retry')}</Button>
      </div>}
      {view.seed !== null && !ready && <div className={css.empty} role={canvas.failed ? 'alert' : 'status'}>
        {t(canvas.failed ? 'editorFailed' : 'editorStarting')}
        {canvas.failed && <Button size="sm" onClick={canvas.retry}>{t('retry')}</Button>}
      </div>}
    </section>
    {dialog === 'export' && <Modal open trapFocus title={t(kind === 'word' ? 'exportWord' : 'exportExcel')}
      onClose={() => { if (!pending) closeDialog(exportButton.current) }} closeLabel={t('close')} description={t('exportDescription')}
      footer={<>
        <Button disabled={pending} onClick={() => { closeDialog(exportButton.current) }}>{t('cancel')}</Button>
        <Button autoFocus variant="primary" disabled={pending} onClick={() => { void exportDocument() }}>
          {t(kind === 'word' ? 'downloadWord' : 'downloadExcel')}
        </Button>
      </>}>
      {pending && <p role="status">{t('exporting')}</p>}
      {notice !== null && <p role="alert" className={css.error}>{t(notice)}</p>}
    </Modal>}
    {dialog === 'conflict' && <Modal open trapFocus title={t('resolve')} description={t('conflictDescription')}
      onClose={() => { if (!pending) closeDialog(resolveButton.current) }} closeLabel={t('close')}
      footer={<>
        <Button autoFocus disabled={pending} onClick={() => { closeDialog(resolveButton.current) }}>{t('keepEditing')}</Button>
        {!reviewed && <Button disabled={pending} onClick={() => {
          if (controller.current !== null) void review(controller.current, dialogEpoch.current)
        }}>{t('retry')}</Button>}
        <Button disabled={pending || !reviewed} onClick={() => {
          if (controller.current?.useLatest() === true) closeDialog(resolveButton.current)
        }}>{t('useLatest')}</Button>
        <Button variant="primary" disabled={pending || !reviewed || blocked} onClick={() => { void replace() }}>{t('replaceLatest')}</Button>
      </>}>
      {pending && <p role="status">{t(view.status === 'saving' ? 'saving' : 'resolving')}</p>}
      {notice !== null && <p role="alert" className={css.error}>{t(notice)}</p>}
    </Modal>}
    {toast !== null && <Toast key={toast.id} text={t(toast.key)} onDone={() => { setToast(null) }} />}
  </div>
}
