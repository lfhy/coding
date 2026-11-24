/** 仅在可见正文中启动一个本地编辑实例，不把第三方对象交给业务组件。 */
import { throwError } from 'rxjs'
import { createUniver, IConfigService, LocaleType, NamedStyleType, Univer, CommandType, type ILanguagePack,
  type IPreset } from '@univerjs/presets'
import { DOCS_UI_PLUGIN_CONFIG_KEY, IRenderManagerService } from '@univerjs/preset-docs-core'
import { UniverDocsDrawingPlugin } from '@univerjs/docs-drawing'
// facade 是副作用入口：它把 `insertImage` 挂到文档 facade 上，必须显式加载。
import '@univerjs/docs-drawing/facade'
import { en as english, zh as chinese } from './locales.ts'
import type { OfficeDocument, ParagraphAlign, ParagraphStyle } from './office-document.ts'
import { markOfficeHost, HOST_CLASS } from './office-portal.ts'
import { selfScopedRules } from './office-scope.ts'
import { fromUniverDocument, toUniverDocument } from './word-conversion.ts'
import { fromUniverWorkbook, toUniverWorkbook } from './excel-conversion.ts'

/** 引擎颜色服务的可替换面：只需换掉取色方法。 */
interface PaperColorService {
  getRenderColor(color: string): string
  readonly _resolvedThemeColors?: Map<string, string>
  readonly _themeService?: { getTheme(): Record<string, Record<string, string>> }
}

/**
 * Word 正文在暗色下保持白纸。Univer 的颜色服务在暗色里把所有主题色反相：白纸变黑底、
 * 与页面背景融为一体，正文文字变白后在白纸上又不可见。渲染插件在启动期重新注册该服务，
 * createUniver 的 override 会被覆盖掉，所以等文档渲染单元就绪后直接把实例的取色方法换成
 * 透传实现：纸面与正文一律按浅色主题取色（白纸、黑字、浅灰线条）；纸外的桌面直接取
 * 侧边栏底色，跟随当前主题。
 * @param univer - 当前编辑器实例；须在文档渲染单元注册之后调用，未就绪时按 50ms 间隔重试。
 */
function bindPaperColors(univer: Univer): void {
  const renderManager: IRenderManagerService = univer.__getInjector().get(IRenderManagerService)
  const service = (): PaperColorService | undefined =>
    renderManager.getRenderUnitById(UNIT_ID)?.engine?.canvasColorService as PaperColorService | undefined
  /** 桌面底色与侧边栏共用同一个 token，主题切换后每次取色都读到当前值。 */
  const deskColor = (fallback: string): string =>
    document.defaultView?.getComputedStyle(document.body).getPropertyValue('--dsw-specific-sidebar-fill').trim() || fallback
  const bind = (attempts: number) => {
    const target = service()
    if (target === undefined) {
      if (attempts < 20) setTimeout(() => bind(attempts + 1), 50)
      return
    }
    const resolved = target._resolvedThemeColors
    target.getRenderColor = (color: string) => {
      const cached = resolved?.get(color)
      // 分页版式的桌面底（gray.100）换成侧边栏底色，纸张之外露出的是工作台的面。
      if (color === 'gray.100') return deskColor(cached ?? '#ffffff')
      if (cached !== undefined) return cached
      // 令牌形如「调色板.级别」（gray.0）；缓存缺位时退回当前主题的浅色色板。
      const dot = color.indexOf('.')
      if (dot > 0) {
        const value = target._themeService?.getTheme()?.[color.slice(0, dot)]?.[color.slice(dot + 1)]
        if (typeof value === 'string') return value
      }
      return color
    }
  }
  bind(0)
}

/**
 * 把画布上方浮层的滚轮转发给画布本身。
 * Univer 的滚动监听绑在 canvas 上，而正文字符输入层压在画布顶部：真实滚轮落在输入层上，
 * 引擎收不到事件就会表现为「长文档完全不能滚」。这里只转发没有落在画布上的滚轮。
 * @param container - 承载画布的宿主元素。
 * @param signal - 组件释放信号，随画布一起移除监听。
 */
function bindWheelForwarding(container: HTMLElement, signal: AbortSignal): void {
  container.addEventListener('wheel', (event) => {
    const canvas = container.querySelector('canvas')
    if (canvas === null || event.target === canvas) return
    canvas.dispatchEvent(new WheelEvent('wheel', {
      deltaX: event.deltaX, deltaY: event.deltaY, deltaMode: event.deltaMode,
      clientX: event.clientX, clientY: event.clientY, bubbles: true, cancelable: true,
    }))
    event.preventDefault()
  }, { signal, passive: false })
}

/** 文档组件与纸张背景组件都按 pageMarginTop 排页，改它就能收拢页间空白。 */
interface PageGapTarget {
  pageMarginTop: number
  makeDirty?(dirty: boolean): void
}

/**
 * 纸张背景组件：页描边与页间距一起决定两页看起来是否断开。
 * 组件的填充字段默认是 undefined（绘制时才回退到主题色），所以只能原样透传，不能填空串。
 */
interface PagePaperTarget extends PageGapTarget {
  _backgroundFillColor?: string
  _pageFillColor?: string
  _pageStrokeColor?: string
  setFillColors?(background: string | undefined, page: string | undefined, stroke: string | undefined, margin: string | undefined): void
}

/**
 * 双击两页之间的空白，把分页纸张拼成一整张长页；再双击还原，与 WPS / Word 隐藏页间空白的手感一致。
 * 命中判定直接读画布像素：双击处不是纸白、而上下各留 40px 都是纸白时，说明点在页间空隙上，
 * 这样不用换算视图缩放，缩放或改版式后依然准。
 * @param container - 承载画布的宿主元素。
 * @param univer - 当前编辑器实例；须在文档渲染单元注册之后调用。
 * @param signal - 组件释放信号，随画布一起移除监听。
 */
function bindPageGapToggle(container: HTMLElement, univer: Univer, signal: AbortSignal): void {
  const renderManager: IRenderManagerService = univer.__getInjector().get(IRenderManagerService)
  let pageGap: number | undefined
  let pageStroke: string | undefined
  const targets = () => {
    const render = renderManager.getRenderUnitById(UNIT_ID)
    return {
      main: render?.mainComponent as PageGapTarget | null | undefined,
      background: render?.components?.get('__Document_Render_Background__') as PagePaperTarget | undefined,
    }
  }
  const toggle = (): void => {
    const { main, background } = targets()
    if (main === null || main === undefined) return
    if (main.pageMarginTop > 0) {
      pageGap = main.pageMarginTop
      main.pageMarginTop = 0
    } else {
      main.pageMarginTop = pageGap ?? 0
    }
    main.makeDirty?.(true)
    if (background !== undefined) {
      background.pageMarginTop = main.pageMarginTop
      // 拼页时把纸张描边一起隐掉，两页才会连成一整张；还原时交回原描边（默认 undefined 即主题色）。
      if (pageStroke === undefined) pageStroke = background._pageStrokeColor
      const stroke = main.pageMarginTop > 0 ? pageStroke : 'transparent'
      background.setFillColors?.(background._backgroundFillColor, background._pageFillColor, stroke, stroke)
      background.makeDirty?.(true)
    }
  }
  const GAP_PROBE = 40
  const GAP_SLACK = 12
  container.addEventListener('dblclick', (event) => {
    const canvas = container.querySelector('canvas')
    if (canvas === null) return
    const rect = canvas.getBoundingClientRect()
    const ratio = canvas.width / rect.width
    const x = Math.round((event.clientX - rect.left) * ratio)
    const y = Math.round((event.clientY - rect.top) * ratio)
    const ctx = canvas.getContext('2d')
    if (ctx === null) return
    const white = (atY: number): boolean => {
      if (atY < 0 || atY >= canvas.height) return false
      const [red = 0, green = 0, blue = 0] = ctx.getImageData(x, atY, 1, 1).data
      return red > 235 && green > 235 && blue > 235
    }
    // 页间空白可能只有几像素宽，双击落点允许上下浮动一档，避免“明明点到了却没反应”。
    for (let offset = -GAP_SLACK; offset <= GAP_SLACK; offset += 3) {
      const at = y + offset
      if (!white(at) && white(at - GAP_PROBE) && white(at + GAP_PROBE)) {
        toggle()
        return
      }
    }
  }, { signal })
}

/** 只暴露原生格式能保存的格式化动作。 */
export type OfficeFormat =
  | { key: 'bold' | 'italic' | 'underline' | 'strike' | 'undo' | 'redo' | 'merge' | 'unmerge' }
  | { key: 'textColor' | 'background' | 'numberFormat'; value: string }
  | { key: 'style'; value: ParagraphStyle }
  | { key: 'align'; value: ParagraphAlign }
  | { key: 'fontSize'; value: number }

/** 文档 facade 上的插图能力；由 `UniverDocsDrawingPlugin` 注册后提供。 */
type InsertableImageDocument = {
  insertImage(options: {
    readonly source: string
    readonly imageSourceType: 'BASE64'
    readonly wrappingStyle: 'inline'
  }): Promise<object | null>
}

/** 每份画布单独拥有读快照、结束编辑、事件和释放权。 */
export interface OfficeEngine {
  read(): OfficeDocument
  isEditing(): boolean
  finishEditing(): Promise<boolean>
  format(action: OfficeFormat): Promise<boolean>
  /** 把图片作为行内对象插入当前选区；读取失败或命令失败时返回 false。 */
  insertImage(image: Blob): Promise<boolean>
  dispose(): void
}

/** 读取图片的 data URL；失败时拒绝，由调用方决定如何提示。 */
async function readImageDataUrl(image: Blob): Promise<string> {
  const reader = new FileReader()
  const loaded = new Promise<string>((resolve, reject) => {
    reader.onload = () => { resolve(typeof reader.result === 'string' ? reader.result : '') }
    reader.onerror = () => { reject(reader.error ?? new Error('图片读取失败')) }
  })
  reader.readAsDataURL(image)
  return await loaded
}

interface OfficeEngineOptions {
  readonly container: HTMLElement
  readonly document: OfficeDocument
  readonly onChange: () => void
  readonly signal: AbortSignal
}

const UNIT_ID = 'office-content'
const DARK_PREFERENCE = '(prefers-color-scheme: dark)'
// 纸张四周留给桌面的宽度：fit-width 把 A4 纸缩进画布时左右各留这段桌面。
const PAGE_DESK_MARGIN = 24
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
 * 让 A4 纸按画布宽度缩放适配：窄窗口里整张纸都能看到，不会出现横向滚动条。
 * 用的是 Univer 自己的 fit-width 视图缩放，页脚缩放控件仍可在此基础上继续放大；
 * 默认 minScale 是 1，必须放宽才允许缩到比页面更窄的容器里。纸张居中，两侧留出桌面。
 * @param univer - 当前编辑器实例。
 */
function bindFitToWidth(univer: Univer): void {
  const config: IConfigService = univer.__getInjector().get(IConfigService)
  config.setConfig(DOCS_UI_PLUGIN_CONFIG_KEY, {
    fitToWidth: { mode: 'fit-width', target: 'container', align: 'start', paddingX: PAGE_DESK_MARGIN, minScale: 0.25 },
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

function clipboardHandling(container: HTMLElement, insertImage: (image: File) => void): () => void {
  const paste = (event: ClipboardEvent) => {
    const data = event.clipboardData
    if (data === null) return
    // 截图与图片文件按行内图片插入；其余富文本仍然只保留纯文字。
    const image = [...data.files].find(file => file.type.startsWith('image/'))
    if (image !== undefined) {
      event.preventDefault()
      event.stopImmediatePropagation()
      insertImage(image)
      return
    }
    if (!data.types.includes('text/html')) return
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
  const releaseHost = markOfficeHost()
  // 粘贴回调在画布创建前就安装好，这里留一个在模型就绪后替换的入口。
  let insertImageIntoDocument: (image: Blob) => Promise<boolean> = () => Promise.resolve(false)
  const releasePaste = clipboardHandling(container, (image) => { void insertImageIntoDocument(image) })
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
    insertImageIntoDocument = image => model.insertImage(image)
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
  const layout = { container, toolbar: false } as const
  if (input.kind === 'word') {
    const [docs, zh, en, { default: css }] = await Promise.all([
      import('@univerjs/preset-docs-core'), import('@univerjs/preset-docs-core/locales/zh-CN'),
      import('@univerjs/preset-docs-core/locales/en-US'), import('@univerjs/preset-docs-core/lib/index.css?inline'),
    ])
    signal.throwIfAborted()
    // 正文右键菜单由 Univer 提供（剪切/复制/粘贴与行内格式），表格编辑器仍然关着。
    const runtime = newRuntime(docs.UniverDocsCorePreset({
      ...layout, contextMenu: true, header: false, footer: true, toc: true, disableAutoFocus: true,
    }), localePack(zh), localePack(en), docs.IHTTPImplementation)
    // 图片是浮动对象，由绘图插件提供命令与渲染；不注册时画布插不进图片。
    runtime.univer.registerPlugin(UniverDocsDrawingPlugin)
    bindFitToWidth(runtime.univer)
    const api = runtime.univerAPI
    return bindRuntime(options, css, runtime, () => {
      const model = api.createDocument(toUniverDocument(input, UNIT_ID, ''))
      // 渲染单元随文档注册；此时把颜色服务换成透传实现，正文才能保持白纸。
      bindPaperColors(runtime.univer)
      bindPageGapToggle(container, runtime.univer, signal)
      bindWheelForwarding(container, signal)
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
        insertImage: async (image) => {
          const source = await readImageDataUrl(image)
          if (source === '') return false
          // 插件在 facade 上补出 `insertImage`；类型没有合并过来，这里按运行时契约声明。
          const target = api.getActiveDocument() as unknown as InsertableImageDocument | null
          if (target === null) return false
          try {
            return await target.insertImage({ source, imageSourceType: 'BASE64', wrappingStyle: 'inline' }) !== null
          } catch { return false }
        },
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
    ...layout, contextMenu: false, header: true, formulaBar: true, sheets: { enableFillHandle: false },
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
      // Excel 的浮动图片需要绘图插件，当前装配下它会让工作簿起不来，先只保留 Word。
      insertImage: () => Promise.resolve(false),
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
