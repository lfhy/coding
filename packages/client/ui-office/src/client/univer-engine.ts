/** 仅在可见正文中启动一个本地编辑实例，不把第三方对象交给业务组件。 */
import { throwError } from 'rxjs'
import { createUniver, ICommandService, IConfigService, ILogService, IUniverInstanceService, LocaleType, NamedStyleType,
  setDependencies, ThemeService, Univer, UniverInstanceType, CommandType, type DocumentDataModel, type ILanguagePack,
  type IPreset } from '@univerjs/presets'
import {
  DocLayoutExecutorService, DocLayoutInteractionService, DocPageLayoutService,
  DocRenderController, DocSelectionManagerService, DocSelectionRenderService, DocSkeletonManagerService,
  DocViewScaleService, DOCS_UI_PLUGIN_CONFIG_KEY, IEditorService, IRenderManagerService, type IRenderContext,
} from '@univerjs/preset-docs-core'
import { en as english, zh as chinese } from './locales.ts'
import type { OfficeDocument, ParagraphAlign, ParagraphStyle } from './office-document.ts'
import { markOfficeHost, HOST_CLASS } from './office-portal.ts'
import { selfScopedRules } from './office-scope.ts'
import { fromUniverDocument, toUniverDocument } from './word-conversion.ts'
import { fromUniverWorkbook, toUniverWorkbook } from './excel-conversion.ts'

/** 桌面版按固定 960px 排版；这里改为跟随画布宽度，正文两侧仍保留页面边距。 */
type LayoutArgs = Parameters<DocRenderController['_scheduleLayout']>
type LayoutOptions = LayoutArgs[2]
class NoteDocRenderController extends DocRenderController {
  declare protected _context: IRenderContext<DocumentDataModel>

  protected override _getHorizontalPageMargin(): number {
    return DOCUMENT_GUTTER
  }

  protected override _scheduleLayout(...args: LayoutArgs): void {
    const [unitId, skeleton, options, refreshMainSelection, preserveInactiveViewportAnchor] = args
    const parent = this._context.scene.getParent()
    // 画布尚未挂载时场景父级宽度仍是初始占位值，此时沿用编辑器自身的宽度。
    // 页面宽度直接跟随画布：fit-width 缩放再把它等比缩进画布，减留白反而溢出。
    const available = parent.width > 1 ? parent.width : this._context.engine.width
    const bound = Number.isFinite(available) && available > 1
      ? { ...options, modernPageWidth: available, modernHorizontalMargin: this._getHorizontalPageMargin() } satisfies LayoutOptions
      : options
    super._scheduleLayout(unitId, skeleton, bound, refreshMainSelection, preserveInactiveViewportAnchor)
  }
}
// 第 0 个参数是渲染单元创建时传入的渲染上下文，其余依赖从第 1 个参数起注入。子类不继承父类构造参数上的
// 依赖装饰器，仓库又未开启装饰器编译，所以在模块加载时登记一次：setDependencies 是追加语义，重复调用会让
// 同一构造参数出现两个依赖描述符。
setDependencies(NoteDocRenderController, [
  ICommandService, DocSelectionRenderService, DocSkeletonManagerService, IEditorService, IRenderManagerService,
  IUniverInstanceService, DocPageLayoutService, DocSelectionManagerService, DocViewScaleService, ThemeService,
  DocLayoutExecutorService, DocLayoutInteractionService, ILogService,
], 1)

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
// 页面左侧留给段落柄的宽度：正文从画布左缘缩进这段距离，段落柄停靠在其中。
const DOCUMENT_GUTTER = 72
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

/**
 * 把连续布局的正文宽度绑定到画布，并让文档组件把左侧留白算进外边距。
 *
 * 桌面版 Word 画布按 960px 定宽排版，页面左侧的 50px 留白落不到视口里：段落柄按
 * 「页面左边距」停靠，被画布边界推到正文右缘后裁成一条竖线。这里把文档的渲染控制器
 * 换成跟随容器宽度的实现（Univer 移动端同款做法）。渲染模块按标识去重、先登记者生效，
 * 所以必须在 DocsUI 插件登记原控制器之前调用；createUniver 返回时插件只跑到 Starting 阶段。
 */
function bindContinuousLayout(univer: Univer): void {
  const renderManager: IRenderManagerService = univer.__getInjector().get(IRenderManagerService)
  renderManager.registerRenderModule(UniverInstanceType.UNIVER_DOC, [DocRenderController, { useClass: NoteDocRenderController }])
}

/**
 * 让页面按画布宽度缩放适配：窄窗口里默认整页可见，不会出现横向滚动条。
 * 用的是 Univer 自己的 fit-width 视图缩放，页脚缩放控件仍可在此基础上继续放大；
 * 默认 minScale 是 1，必须放宽才允许缩到比页面更窄的容器里。
 * @param univer - 当前编辑器实例。
 */
function bindFitToWidth(univer: Univer): void {
  const config: IConfigService = univer.__getInjector().get(IConfigService)
  config.setConfig(DOCS_UI_PLUGIN_CONFIG_KEY, {
    fitToWidth: { mode: 'fit-width', target: 'container', align: 'start', paddingX: DOCUMENT_GUTTER, minScale: 0.25 },
  }, { merge: true })
}

function setupStyles(container: HTMLElement, css: string): () => void {
  const style = document.createElement('style')
  const scoped = css.replaceAll(/url\([^)]*\)/g, 'none')
  // 画布根由编辑器独占；Univer 的浮层是 body 直属节点，靠宿主类名一并圈进作用域。
  // @scope 的规则不匹配作用域根元素，浮层容器自身另用补充规则（见 office-scope.ts）。
  style.textContent = `@scope (.coding-office-canvas, [id^="univer-popup-portal-"], body.${HOST_CLASS} > *) {${scoped}}${selfScopedRules(scoped)}`
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
  http: typeof import('@univerjs/preset-docs-core')['IHTTPImplementation'], gutter: boolean,
) {
  const runtime = createUniver({
    presets: [preset], locale: language(), darkMode: darkMode(),
    locales: { [LocaleType.ZH_CN]: zh, [LocaleType.EN_US]: en },
    override: [[http, { useValue: { send: () => throwError(() => new Error('Offline office editor')) } }]],
  })
  if (gutter) bindContinuousLayout(runtime.univer)
  return runtime
}

function bindRuntime(options: OfficeEngineOptions, presetCss: string, runtime: ReturnType<typeof newRuntime>,
  createModel: () => Omit<OfficeEngine, 'dispose'>): OfficeEngine {
  const { container, onChange, document: input } = options
  const { univer, univerAPI } = runtime
  const releaseStyle = setupStyles(container, presetCss)
  const releaseHost = markOfficeHost()
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
      releaseHost()
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
      ...layout, header: false, footer: true, toc: true, disableAutoFocus: true,
    }), localePack(zh), localePack(en), docs.IHTTPImplementation, true)
    bindFitToWidth(runtime.univer)
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
  }), localePack(zh), localePack(en), sheets.IHTTPImplementation, false)
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
