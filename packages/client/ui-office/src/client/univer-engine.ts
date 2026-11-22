/** 仅在可见正文中启动一个本地编辑实例，不把第三方对象交给业务组件。 */
import { throwError } from 'rxjs'
import { CommandType, createUniver, LocaleType, NamedStyleType, type ILanguagePack, type IPreset } from '@univerjs/presets'
import { en as english, zh as chinese } from './locales.ts'
import type { OfficeDocument, ParagraphAlign, ParagraphStyle } from './office-document.ts'
import { fromUniverDocument, toUniverDocument } from './word-conversion.ts'
import { fromUniverWorkbook, toUniverWorkbook } from './excel-conversion.ts'

/** 只暴露原生格式能保存的格式化动作。 */
export type OfficeFormat =
  | { key: 'bold' | 'italic' | 'underline' | 'strike' | 'undo' | 'redo' | 'merge' | 'unmerge' }
  | { key: 'textColor' | 'background' | 'numberFormat'; value: string }
  | { key: 'style'; value: ParagraphStyle }
  | { key: 'align'; value: ParagraphAlign }
  | { key: 'fontSize'; value: number }

/** 每份画布单独拥有读快照、结束编辑、事件和释放权。 */
export interface OfficeEngine {
  read(): OfficeDocument
  isEditing(): boolean
  finishEditing(): Promise<boolean>
  format(action: OfficeFormat): Promise<boolean>
  dispose(): void
}

interface OfficeEngineOptions {
  readonly container: HTMLElement
  readonly document: OfficeDocument
  readonly onChange: () => void
  readonly signal: AbortSignal
}

const UNIT_ID = 'office-content'
const DARK_PREFERENCE = '(prefers-color-scheme: dark)'
const NAMED: Record<ParagraphStyle, NamedStyleType> = {
  normal: NamedStyleType.NORMAL_TEXT,
  title: NamedStyleType.TITLE,
  heading1: NamedStyleType.HEADING_1,
  heading2: NamedStyleType.HEADING_2,
  heading3: NamedStyleType.HEADING_3,
}

function darkMode(): boolean {
  const scheme = document.documentElement.style.colorScheme
  if (scheme === 'dark' || scheme === 'light') return scheme === 'dark'
  return document.defaultView?.matchMedia(DARK_PREFERENCE).matches ?? false
}

function language(): LocaleType {
  return document.documentElement.lang.toLowerCase().startsWith('zh') ? LocaleType.ZH_CN : LocaleType.EN_US
}

function localePack(module: { default: unknown }): ILanguagePack {
  const value = module.default
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid locale pack')
  return value as ILanguagePack
}

function setupStyles(container: HTMLElement, css: string): () => void {
  const style = document.createElement('style')
  // 画布根由编辑器独占；样式在文档头中保持有效，选择器只作用于画布及其浮层。
  style.textContent = `@scope (.coding-office-canvas, [id^="univer-popup-portal-"]) {${css.replaceAll(/url\([^)]*\)/g, 'none')}}`
  container.classList.add('coding-office-canvas')
  document.head.append(style)
  return () => { style.remove(); container.classList.remove('coding-office-canvas') }
}

function labelControls(container: HTMLElement, documentKind: OfficeDocument['kind'], locale: LocaleType): void {
  const copy = locale === LocaleType.ZH_CN ? chinese : english
  // 画布自己创建的输入和图标按钮需补充名称；不改变其焦点或命令处理。
  for (const input of container.querySelectorAll('[data-u-comp="editor"][contenteditable="true"]')) {
    input.setAttribute('role', 'textbox')
    input.setAttribute('aria-label', documentKind === 'word' ? copy.documentInput
      : input.id.endsWith('FORMULA_BAR') ? copy.formulaInput : copy.cellInput)
  }
  for (const button of container.querySelectorAll('button[data-u-comp="sheet-bar-append-button"]')) {
    const opensList = button.closest('[data-slot="dropdown-menu-trigger"]') !== null
    button.setAttribute('aria-label', opensList ? copy.sheetList : copy.addSheet)
  }
}

function onlyTextClipboard(container: HTMLElement): () => void {
  const paste = (event: ClipboardEvent) => {
    const data = event.clipboardData
    if (data === null || (!data.types.includes('text/html') && data.files.length === 0)) return
    event.preventDefault()
    event.stopImmediatePropagation()
    const text = data.getData('text/plain')
    if (text === '') return
    // 不把外部富文本和远程图片交给编辑器，也不请求更宽的剪贴板权限。
    const plain = new DataTransfer()
    plain.setData('text/plain', text)
    event.target?.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: plain }))
  }
  container.addEventListener('paste', paste, true)
  return () => { container.removeEventListener('paste', paste, true) }
}

function newRuntime(
  preset: IPreset, zh: ILanguagePack, en: ILanguagePack,
  http: typeof import('@univerjs/preset-docs-core')['IHTTPImplementation'],
) {
  return createUniver({
    presets: [preset], locale: language(), darkMode: darkMode(),
    locales: { [LocaleType.ZH_CN]: zh, [LocaleType.EN_US]: en },
    override: [[http, { useValue: { send: () => throwError(() => new Error('Offline office editor')) } }]],
  })
}

function bindRuntime(options: OfficeEngineOptions, presetCss: string, runtime: ReturnType<typeof newRuntime>,
  createModel: () => Omit<OfficeEngine, 'dispose'>): OfficeEngine {
  const { container, onChange, document: input } = options
  const { univer, univerAPI } = runtime
  const releaseStyle = setupStyles(container, presetCss)
  const releasePaste = onlyTextClipboard(container)
  const media = document.defaultView?.matchMedia(DARK_PREFERENCE)
  let disposed = false
  let scheduled = false
  let offCommand: { dispose(): void } | undefined
  let wasDark = darkMode()
  let wasLanguage = language()
  const label = () => { labelControls(container, input.kind, wasLanguage) }
  const controlObserver = new MutationObserver(label)
  const appearance = () => {
    const dark = darkMode()
    const locale = language()
    if (dark !== wasDark) {
      wasDark = dark
      univerAPI.toggleDarkMode(dark)
    }
    if (locale !== wasLanguage) {
      wasLanguage = locale
      univerAPI.setLocale(locale)
      label()
    }
  }
  const observer = new MutationObserver(appearance)
  const dispose = () => {
    if (disposed) return
    disposed = true
    observer.disconnect()
    controlObserver.disconnect()
    media?.removeEventListener('change', appearance)
    releasePaste()
    offCommand?.dispose()
    try {
      univer.dispose()
    } finally {
      releaseStyle()
    }
  }
  try {
    const model = createModel()
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['style', 'lang'] })
    controlObserver.observe(container, { childList: true, subtree: true })
    label()
    media?.addEventListener('change', appearance)
    offCommand = univerAPI.addEvent(univerAPI.Event.CommandExecuted, ({ type, id }) => {
      if (disposed || scheduled || type !== CommandType.MUTATION || !id.startsWith(input.kind === 'word' ? 'doc.' : 'sheet.')) return
      // 同一动作可能提交多个变更；取命令栈完全结束后的完整快照。
      scheduled = true
      queueMicrotask(() => {
        scheduled = false
        if (!disposed) onChange()
      })
    })
    return { ...model, dispose }
  } catch (error) {
    dispose()
    throw error
  }
}

/**
 * 加载当前类型的开源预设，另外一种预设不实例化。取消时不创建画布。
 * @param options - 当前内容、活动容器及快照通知。
 * @returns 单文档编辑实例；调用方离开时必须释放它。
 */
export async function createOfficeEngine(options: OfficeEngineOptions): Promise<OfficeEngine> {
  const { container, document: input, signal } = options
  const layout = { container, toolbar: false, contextMenu: false } as const
  if (input.kind === 'word') {
    const [docs, zh, en, { default: css }] = await Promise.all([
      import('@univerjs/preset-docs-core'), import('@univerjs/preset-docs-core/locales/zh-CN'),
      import('@univerjs/preset-docs-core/locales/en-US'), import('@univerjs/preset-docs-core/lib/index.css?inline'),
    ])
    signal.throwIfAborted()
    const runtime = newRuntime(docs.UniverDocsCorePreset({
      ...layout, header: false, footer: false, toc: false, disableAutoFocus: true,
    }), localePack(zh), localePack(en), docs.IHTTPImplementation)
    const api = runtime.univerAPI
    return bindRuntime(options, css, runtime, () => {
      const model = api.createDocument(toUniverDocument(input, UNIT_ID, ''))
      const toggle = {
        bold: docs.SetInlineFormatBoldCommand, italic: docs.SetInlineFormatItalicCommand,
        underline: docs.SetInlineFormatUnderlineCommand, strike: docs.SetInlineFormatStrikethroughCommand,
      }
      const align = {
        left: docs.AlignLeftCommand, center: docs.AlignCenterCommand, right: docs.AlignRightCommand, justify: docs.AlignJustifyCommand,
      }
      return {
        read: () => fromUniverDocument(model.save()),
        isEditing: () => false,
        finishEditing: () => Promise.resolve(true),
        format: (action) => {
          switch (action.key) {
            case 'undo': case 'redo': return api.executeCommand(`univer.command.${action.key}`)
            case 'bold': case 'italic': case 'underline': case 'strike': return api.executeCommand(toggle[action.key].id)
            case 'style': return api.executeCommand(docs.SetParagraphNamedStyleCommand.id, { value: NAMED[action.value] })
            case 'align': return api.executeCommand(align[action.value].id)
            case 'fontSize': return api.executeCommand(docs.SetInlineFormatFontSizeCommand.id, { value: action.value })
            case 'textColor': return api.executeCommand(docs.SetInlineFormatTextColorCommand.id, { value: action.value })
            default: return Promise.resolve(false)
          }
        },
      }
    })
  }
  const [sheets, zh, en, { default: css }] = await Promise.all([
    import('@univerjs/preset-sheets-core'), import('@univerjs/preset-sheets-core/locales/zh-CN'),
    import('@univerjs/preset-sheets-core/locales/en-US'), import('@univerjs/preset-sheets-core/lib/index.css?inline'),
  ])
  signal.throwIfAborted()
  const runtime = newRuntime(sheets.UniverSheetsCorePreset({
    // 头部挂载公式栏；disableAutoFocus 会关闭表格键入监听，不只是阻止首屏抢焦点。
    ...layout, header: true, formulaBar: true, sheets: { enableFillHandle: false },
    footer: { sheetBar: true, statisticBar: false, menus: false, zoomSlider: false },
  }), localePack(zh), localePack(en), sheets.IHTTPImplementation)
  const api = runtime.univerAPI
  return bindRuntime(options, css, runtime, () => {
    const model = api.createWorkbook(toUniverWorkbook(input, UNIT_ID, ''))
    const toggle = {
      bold: sheets.SetRangeBoldCommand, italic: sheets.SetRangeItalicCommand,
      underline: sheets.SetRangeUnderlineCommand, strike: sheets.SetRangeStrickThroughCommand,
    }
    return {
      read: () => fromUniverWorkbook(model.save()),
      isEditing: () => model.isCellEditing(),
      finishEditing: () => model.isCellEditing() ? model.endEditingAsync(true) : Promise.resolve(true),
      format: (action) => {
        switch (action.key) {
          case 'undo': case 'redo': return api.executeCommand(`univer.command.${action.key}`)
          case 'bold': case 'italic': case 'underline': case 'strike': return api.executeCommand(toggle[action.key].id)
          case 'textColor': return api.executeCommand(sheets.SetRangeTextColorCommand.id, { value: action.value })
          case 'background': case 'numberFormat': {
            const range = model.getActiveRange()
            if (range === null) return Promise.resolve(false)
            if (action.key === 'background') range.setBackgroundColor(action.value)
            else range.setNumberFormat(action.value)
            return Promise.resolve(true)
          }
          case 'merge': return api.executeCommand(sheets.AddWorksheetMergeAllCommand.id)
          case 'unmerge': return api.executeCommand(sheets.RemoveWorksheetMergeCommand.id)
          default: return Promise.resolve(false)
        }
      },
    }
  })
}
