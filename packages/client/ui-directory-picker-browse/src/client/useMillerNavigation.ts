/**
 * Miller 视图的导航状态机：层级扫描与落地、两程的静默合并、选中与推进、路径
 * 草稿跟随，以及落地后的焦点停放。谁超时、谁被取代、谁继续都在这里定义一次。
 * 落地「以选中项为锚且安静」：扫描期间旧视图照旧渲染，目标与父层两程尽量合成
 * 单个双栏帧，于是后退不闪中间帧，也不把显示根以上的层级塌成单栏。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { MutableRefObject } from 'react'
import type { Translate } from 'coding-client-locale/client'
import type { DirectoryEntry, DirectoryListing } from 'coding-client-runtime/client'
import {
  displayCrumbs, failureText, readDraft, separatorOf,
} from './paths.ts'
import type { ScannedDirectory } from './paths.ts'

/** 扫描保持视觉安静的时长，过后才浮出「加载中…」胶囊；窗口内落地直接换栏。 */
const SLOW_SCAN_DELAY_MS = 300

/** 落地等父层这一程的上限：超界先单栏落地，迟到的父层就地升级。 */
const PARENT_LEG_WAIT_MS = 200

/** 草稿停顿多久各栏才跟着走到没列举过的目录：吸收穿过中间段的连续按键。 */
const DRAFT_PREVIEW_DEBOUNCE_MS = 250

/** 导航状态机的输入。 */
export interface MillerNavigationOptions {
  /** 对话框可见性（重新打开要回到 Host 主目录）。 */
  open: boolean
  /** 列举一层（省略路径即 Host 主目录）；signal 用于中断被取代的扫描。 */
  listDirectory: (path?: string, signal?: AbortSignal) => Promise<DirectoryListing>
  /** 本地化文案（面包屑的 Home 文案）。 */
  t: Translate
}

/** 导航状态机交给渲染层的全部状态与回调。 */
export interface MillerNavigation {
  /** 左栏层级（当前列举的层）。 */
  parent: DirectoryListing | null
  /** 左栏选中的行（选中后右栏展示其子项）。 */
  selected: DirectoryEntry | null
  /** 右栏层级（选中目录的子项）。 */
  child: DirectoryListing | null
  /** 有列举在飞。 */
  loading: boolean
  /** 慢扫描指示器（只有扫描超过静默窗口才为真）。 */
  slowScan: boolean
  /** 对话框级失败文本。 */
  error: string | null
  /** 路径编辑草稿：null 表示面包屑模式。 */
  pathDraft: string | null
  /** 「显示隐藏文件」开关（纯客户端过滤，重新打开时复位）。 */
  showHidden: boolean
  /** 面包屑显示用行。 */
  crumbs: DirectoryEntry[]
  /** 路径草稿对最后一栏的前缀过滤。 */
  typedPrefix: string | null
  /** 「打开」与新建的目标：选中项，否则当前层。 */
  targetPath: string | null
  /** 目标的显示名（新建对话框正文用）。 */
  targetName: string
  /** 有未提交的路径草稿：提交类动作不得作用于上一轮的选择。 */
  draftPending: boolean
  /** 每一轮打开/关闭的世代号：拟态框用它挡掉过期落地。 */
  generation: MutableRefObject<number>
  /** 面包屑轨迹容器（滚动到尾部）。 */
  crumbTrailRef: MutableRefObject<HTMLSpanElement | null>
  /** 收拢两栏的行容器（滚动到右栏）。 */
  millerRowRef: MutableRefObject<HTMLDivElement | null>
  /** 路径输入框。 */
  pathInputRef: MutableRefObject<HTMLInputElement | null>
  /** 面包屑右侧的编辑区（输入框收起后的焦点落点）。 */
  editZoneRef: MutableRefObject<HTMLButtonElement | null>
  /** IME 守卫（Enter 选中候选词时不提交）。 */
  compositionGuard: { onCompositionStart: () => void; onCompositionEnd: () => void }
  /** IME 组合中标记（提交前读取）。 */
  composingRef: MutableRefObject<boolean>
  /** 切换「显示隐藏文件」。 */
  toggleHidden: () => void
  /** 导航（Enter、面包屑、初始主目录）：编辑器关闭，失败上报。 */
  navigate: (path?: string) => void
  /** 选中左栏的一行并预览其子项。 */
  select: (entry: DirectoryEntry) => void
  /** 右栏的一行被选中：视图向前推进一层。 */
  advance: (entry: DirectoryEntry) => void
  /** 打开路径编辑器（预填尾随分隔符）。 */
  openPathEditor: () => void
  /** 编辑草稿。 */
  editDraft: (value: string) => void
  /** 提交草稿。 */
  submitDraft: () => void
  /** Escape 语义的取消（输入框焦点会回到编辑区）。 */
  escapePathEdit: () => void
  /** 焦点离开卡片的取消（不做焦点停放）。 */
  leavePathEdit: () => void
  /** 新建成功后重新落地目标层并选中新建的文件夹。 */
  landCreated: (parentPath: string, created: DirectoryEntry) => void
  /**
   * 改名/删除成功后重扫该行所属的一栏。
   * @param entryPath - 刚被改动的那一行的路径（用来判断它在哪一栏）。
   * @param nextSelectionPath - 重扫后要选中的目录路径；null 表示退回单栏。
   */
  refreshEntryLevel: (entryPath: string, nextSelectionPath: string | null) => void
}

/**
 * 构建 Miller 导航状态机。
 * @param options - 对话框可见性、列举调用与文案。
 * @returns 渲染层需要的状态、refs 与回调。
 */
export function useMillerNavigation({ open, listDirectory, t }: MillerNavigationOptions): MillerNavigation {
  // Miller 状态：列举的层、其中选中的行、以及选中目录自己的列举（右栏）。
  const [parent, setParent] = useState<DirectoryListing | null>(null)
  const [selected, setSelected] = useState<DirectoryEntry | null>(null)
  const [child, setChild] = useState<DirectoryListing | null>(null)
  const [loading, setLoading] = useState(false)
  // 由下面的慢扫描副作用从 `loading` 与 `scanWindow` 推出：只有当前这次列举
  // 在飞超过 SLOW_SCAN_DELAY_MS 才为真，快列举根本不渲染指示器。
  const [slowScan, setSlowScan] = useState(false)
  // 每次列举都开一个全新的静默窗口：`loading` 可能在取代性或两程导航中一直为真，
  // 它的布尔边沿认不出每次扫描的起点。
  const [scanWindow, setScanWindow] = useState(0)
  const [error, setError] = useState<string | null>(null)
  // 路径编辑状态：null = 面包屑模式；字符串 = 正在键入的草稿。
  const [pathDraft, setPathDraft] = useState<string | null>(null)
  // 显示隐藏文件开关（纯客户端过滤，每次打开时复位）。
  const [showHidden, setShowHidden] = useState(false)
  const requestSeq = useRef(0)
  // 在飞的列举控制器：取代性意图连线上请求一起中断——Host 停止扫描——而不是
  // 只丢弃最终结果、让扫描继续消耗宿主资源。
  const scanController = useRef<AbortController | null>(null)
  // 每次打开/关闭边沿都自增：上一轮打开的落地（进行中的创建也算）绝不能改动
  // 重新打开的对话框。
  const openGeneration = useRef(0)
  // 祖先链过深时轨迹会溢出：链路一变就把尾部（当前目录及旁边的编辑区）带回视野。
  const crumbTrailRef = useRef<HTMLSpanElement | null>(null)
  // IME 确认（Enter 选中候选词）不得提交任何文本输入：与工作区重命名输入框
  // 同一道守卫，路径编辑器与各拟态框共用。
  const composingRef = useRef(false)
  // HMR/卸载失效：已销毁的流程回来的落地不得更新状态，也不得再发请求。
  useEffect(() => () => {
    requestSeq.current += 1
    openGeneration.current += 1
    scanController.current?.abort()
  }, [])
  const compositionGuard = {
    onCompositionStart: () => { composingRef.current = true },
    onCompositionEnd: () => { composingRef.current = false },
  }

  /** 更新的意图获胜：作废在飞列举的落地，并中断它的线上请求。 */
  const supersede = useCallback((): number => {
    scanController.current?.abort()
    scanController.current = null
    return ++requestSeq.current
  }, [])

  /** 隐藏旧指示器并为一次列举开启新的静默窗口。 */
  const restartSlowScanWindow = useCallback((): void => {
    setSlowScan(false)
    setScanWindow(value => value + 1)
  }, [])

  /** 在新的控制器下发起一次列举，保证后续取代能中断它。 */
  const launchListing = useCallback((path: string | undefined): { seq: number; scan: Promise<DirectoryListing> } => {
    const seq = supersede()
    const controller = new AbortController()
    scanController.current = controller
    restartSlowScanWindow()
    return { seq, scan: listDirectory(path, controller.signal) }
  }, [supersede, restartSlowScanWindow, listDirectory])

  /** 在当前取代序号下发起后续列举：更新意图会中断它，它自己不取代任何东西。 */
  const continueScan = useCallback((path: string): Promise<DirectoryListing> => {
    const controller = new AbortController()
    scanController.current = controller
    restartSlowScanWindow()
    return listDirectory(path, controller.signal)
  }, [restartSlowScanWindow, listDirectory])

  /**
   * Enter 从提交到落地之间独占视图，同一批按键点起来的防抖计时器不得取代它；
   * 下一次编辑（或打开编辑器）清掉它，失败的提交保持到那时。
   */
  const previewSuspended = useRef(false)

  // 草稿跟随扫描触发时要读的两栏：是当前值，但不是那次等待的依赖。
  const viewRef = useRef<{ parent: DirectoryListing | null; child: DirectoryListing | null }>({ parent: null, child: null })
  useEffect(() => { viewRef.current = { parent, child } }, [parent, child])

  // 上一次草稿跟随扫描要了什么、拿回了什么：Host 重新拼写路径后那一层仍应答
  // 产生它的文本。匹配需要文本与该层路径同时命中，过期条目因此无害。
  const scanned = useRef<ScannedDirectory | null>(null)

  /** 落地替换掉了可能已被 Tab 到的栏：被丢下的焦点要回到仍打开的编辑器。 */
  const refocusPathInput = useRef(false)

  /**
   * 用刚扫到的层级替换整个视图。离开显示根时落地是双栏的（与面包屑同一折叠
   * 规则，因此两者永不打架）：目标在其父层级里的实际条目被重新选中（左栏 =
   * 父层，右栏 = 目标），一次面包屑跳转读起来就是退后一栏。两程在
   * {@link PARENT_LEG_WAIT_MS} 内落地就合成一帧；超界（或已在显示根）先单栏
   * 落地，迟到的父层就地升级；父层失败或截断窗口里没有目标都保持单栏，升级绝不
   * 弄丢它要锚定的选择。前一个视图全程渲染：落地是换栏，不是清空。提交的路径
   * 到达时关闭编辑器、上报失败并采用等待上界；编辑器自己的草稿跟随扫描是推测性
   * 的，两程都等，一次按键只让视图移动一次。
   * @param path - 要列举的层；省略即 Host 主目录。
   * @param options.closeEditor - 到达后收起路径草稿，并给父层一程加上等待上界。
   * @param options.announce - 失败是否作为对话框的 alert 上报。
   */
  const land = useCallback((path: string | undefined, options: { closeEditor: boolean; announce: boolean }) => {
    const { seq, scan } = launchListing(path)
    setLoading(true)
    if (options.announce) setError(null)
    // 无论哪种形状提交，落地之后都要做的事。
    const settle = (): void => {
      setLoading(false)
      if (options.closeEditor) {
        setPathDraft(null)
        return
      }
      setError(null)
      refocusPathInput.current = true
    }
    scan.then((target) => {
      if (seq !== requestSeq.current) return
      // 接下来的两栏会把这层当作当前层，它应答的就是这段目录文本，无论 Host
      // 如何重新拼写（`..`、Windows 正向斜杠）：末段据此过滤，同一段文本也不再
      // 触发第二次扫描。
      if (!options.closeEditor && path !== undefined) scanned.current = { directory: path, landed: target.path }
      // 单栏落地；`landed` 让它只在首次提交生效，而下方的双栏提交仍可升级已
      // 落地的视图。
      let landed = false
      const landSingle = (): void => {
        if (landed || seq !== requestSeq.current) return
        landed = true
        setParent(target)
        setSelected(null)
        setChild(null)
        settle()
      }
      // 栏数与标签无关：只有折叠后链条的深度决定。
      if (displayCrumbs(target, '').length < 2) { landSingle(); return }
      const parentCrumb = target.crumbs.at(-2)
      /* v8 ignore next -- 收窄：两段以上的显示链必然有父 crumb（根到目标含两端）。 */
      if (parentCrumb === undefined) { landSingle(); return }
      continueScan(parentCrumb.path).then((parentLevel) => {
        if (seq !== requestSeq.current) return
        // Windows 按原拼写 resolve 键入的路径；锚到父层实际条目上，选中比较才成立。
        const sep = separatorOf(parentLevel)
        const fold = (value: string): string => (sep === '\\' ? value.toLowerCase() : value)
        const match = parentLevel.entries.find(entry => fold(entry.path) === fold(target.path))
        if (match === undefined) { landSingle(); return }
        landed = true
        setParent(parentLevel)
        setSelected(match)
        setChild(target)
        // 对超时落地的迟到升级幂等：打开编辑器或开始更新的扫描都会取代这个 seq，
        // 因此能走到这里说明落地仍归它所有。
        settle()
      }, () => {
        // 父层一程的失败（含它自己的 abort）从不上报：目标已经列好了，也没人
        // 要求看父层。
        landSingle()
      })
      // 只有提交的导航有上界：草稿行走把两程都等完（见上方契约），而操作者一旦
      // 先动起来，按键就会中断它。
      if (options.closeEditor) window.setTimeout(landSingle, PARENT_LEG_WAIT_MS)
    }, (reason: unknown) => {
      if (seq !== requestSeq.current) return
      setLoading(false)
      if (options.announce) setError(failureText(reason))
    })
  }, [launchListing, continueScan])

  /** 提交一个路径（Enter、面包屑、初始主目录列举）：编辑器关闭，失败上报。 */
  const navigate = useCallback((path?: string) => {
    land(path, { closeEditor: true, announce: true })
  }, [land])

  // 编辑器关闭后的焦点停放（下方 refocus 副作用消费）：选中停在选中行，Enter 与
  // 输入框内的 Escape 停在 crumb 编辑区；指针移出的取消不设置也不清除这些标记。
  const refocusPick = useRef(false)
  const refocusEditZone = useRef(false)
  const pathInputRef = useRef<HTMLInputElement | null>(null)
  const editZoneRef = useRef<HTMLButtonElement | null>(null)

  /**
   * 选中一层里的一行并预览其子项。刻意不像 navigate() 那样单帧合成：选中态与
   * 分栏本身就是反馈，为子项列举把它压后会让点击像被吞掉。安静规则只管整视图
   * 替换——那里除了替换本身没有任何东西回应点击。
   */
  const select = useCallback((entry: DirectoryEntry) => {
    const { seq, scan } = launchListing(entry.path)
    // 路径编辑器打开时点行收下（已过滤的）行并关闭编辑器——草稿完成了它的使命。
    // 提交后焦点重新停到选中行（见下面的 refocus 副作用）。
    if (pathDraft !== null) refocusPick.current = true
    setPathDraft(null)
    setSelected(entry)
    setChild(null)
    setLoading(true)
    setError(null)
    scan.then((next) => {
      if (seq !== requestSeq.current) return
      setChild(next)
      setLoading(false)
    }, (reason: unknown) => {
      if (seq !== requestSeq.current) return
      setLoading(false)
      setError(failureText(reason))
      // 不可读的选择不能作为提交目标，而面包屑仍指着当前层：退回单栏。
      setSelected(null)
      // 清掉选中可能把这次选中停焦点的行一起卸载（点开头露出的隐藏行会重新隐藏）；
      // refocus 副作用只在焦点确实掉到 body 时才重新停到编辑区。
      refocusEditZone.current = true
    })
  }, [launchListing, pathDraft])

  /**
   * 让各栏走到草稿所指的目录且不关闭编辑器：落地与普通导航一样（选中项为锚、
   * 离开显示根即双栏），草稿末段从下一次渲染起过滤到达的层级。
   */
  const previewDraftLevel = useCallback((directory: string) => {
    land(directory, { closeEditor: false, announce: false })
  }, [land])

  /** 放弃路径编辑（Escape 或点击别处）并恢复面包屑视图。 */
  const cancelPathEdit = useCallback(() => {
    // 取消也撤回编辑器已发起的导航：迟到的成功不得跳到被取消的路径，因此在飞
    // 请求被取代，视图也退出加载态。
    supersede()
    setLoading(false)
    setPathDraft(null)
    setError(null)
    // 编辑可能取代了选中项自己的预览请求；有选中却没有预览会渲染出半空的
    // 双栏视图，因此取消退回单栏层级。
    if (child === null) setSelected(null)
    // 还没列出任何一层时（编辑器取代了初始主目录列举），纯撤销会把选择框永久
    // 留白：重新开始主目录列举。
    if (parent === null) navigate()
  }, [supersede, child, parent, navigate])

  /** 右栏的一行被选中：视图推进一层，子栏成为层。 */
  const advance = useCallback((entry: DirectoryEntry) => {
    /* v8 ignore next -- 收窄守卫：右栏只有在存在子层级列举时才渲染。 */
    if (child === null) return
    setParent(child)
    select(entry)
  }, [child, select])

  // 每次打开都从 Host 主目录重新开始；关闭作废在飞响应，迟到到达不能回填。
  useEffect(() => {
    openGeneration.current += 1
    if (open) {
      setParent(null)
      setSelected(null)
      setChild(null)
      setShowHidden(false)
      navigate()
      return
    }
    supersede()
    // 扫描途中关闭没有要加载的东西；少了这条边沿，重新打开的第一帧就会带着
    // 指示器（重新打开时的 navigate() 不产生加载边沿）。
    setLoading(false)
    setError(null)
    setPathDraft(null)
    // 关闭途中（失败的 Enter 后取消）可能留下挂起的 refocus 标记，退休它们。
    refocusPick.current = false
    refocusEditZone.current = false
  }, [open, navigate, supersede])

  const targetPath = selected?.path ?? parent?.path ?? null
  const targetName = selected?.name
    ?? (parent === null ? '' : (displayCrumbs(parent, t('browser.home')).at(-1)?.name ?? parent.path))
  const crumbSource = child ?? parent
  // 草稿的尾段过滤它所指的层级，按栏不变量那一栏永远是最后一栏——绝不过滤草稿
  // 已经走开的那一栏。
  const typedPrefix = crumbSource === null || pathDraft === null
    ? null
    : readDraft(crumbSource, pathDraft, scanned.current).tail
  const crumbs = crumbSource === null ? [] : displayCrumbs(crumbSource, t('browser.home'))

  // 慢扫描闸门：每次列举都重启计时器，即便 `loading` 连续为真；在自己窗口内
  // 落地就意味着这次替换什么都没露出。
  useEffect(() => {
    if (!loading) {
      setSlowScan(false)
      return
    }
    const timer = window.setTimeout(() => { setSlowScan(true) }, SLOW_SCAN_DELAY_MS)
    return () => { window.clearTimeout(timer) }
  }, [loading, scanWindow])

  // 各栏跟随草稿：每次按键替换挂着的计时器，目标在触发时按当时两栏决定。等待
  // 挂在草稿（而不是它指向的目录部分）上，取代了在飞扫描的按键才会重新挂表、
  // 被拒提交之后的编辑才会解除占用；两栏通过 ref 读，若作为依赖，落地提交的
  // 视图会重新触发等待，Host 用不同拼写应答时就会永远扫下去。
  useEffect(() => {
    if (pathDraft === null) return
    const timer = window.setTimeout(() => {
      if (previewSuspended.current) return
      // 两栏所呈现的当前层：只有它能应答草稿，因此它指名的别处都是要走到的层。
      const current = viewRef.current.child ?? viewRef.current.parent
      if (current === null) return
      const { directory, tail } = readDraft(current, pathDraft, scanned.current)
      if (directory === null || tail !== null) return
      previewDraftLevel(directory)
    }, DRAFT_PREVIEW_DEBOUNCE_MS)
    return () => { window.clearTimeout(timer) }
  }, [pathDraft, previewDraftLevel])

  // 祖先链一变就滚到轨迹尾部：头部右侧的编辑区永远留在视野里。
  const crumbTail = crumbs.at(-1)?.path
  useEffect(() => {
    const trail = crumbTrailRef.current
    if (trail !== null) trail.scrollLeft = trail.scrollWidth
  }, [crumbTail])
  // 视口放不下两个固定栏时 Miller 行横向滚动；子栏一落地就把它钉进视野。
  const millerRowRef = useRef<HTMLDivElement | null>(null)
  const childPath = child?.path
  useEffect(() => {
    const row = millerRowRef.current
    if (row !== null && childPath !== undefined) row.scrollLeft = row.scrollWidth
  }, [childPath])

  // 每次会掉到 body 的编辑器退出都在提交之后重新停放焦点，让键盘遍历留在对话框
  // 内（Modal 没有焦点陷阱）：选中落在 aria-current 行，Enter 与输入框内的 Escape
  // 落在取代输入框的 crumb 编辑区。
  useEffect(() => {
    if (refocusPathInput.current) {
      refocusPathInput.current = false
      // 只在替换确实把焦点丢到 body 时才停：操作者手上的焦点（输入框本身、幸存的
      // 行）归他所有。
      if (document.activeElement === document.body) pathInputRef.current?.focus()
    }
    if (pathDraft !== null) return
    if (refocusPick.current) {
      refocusPick.current = false
      refocusEditZone.current = false
      const rowHost = millerRowRef.current
      /* v8 ignore next -- 收窄守卫：刚提交选中时 Miller 行必然挂载。 */
      if (rowHost === null) return
      const row = rowHost.querySelector<HTMLButtonElement>('button[aria-current="true"]')
      /* v8 ignore next -- 收窄守卫：设置标记的那次选中刚渲染出它的 aria-current 行。 */
      if (row === null) return
      row.focus()
      return
    }
    if (refocusEditZone.current) {
      refocusEditZone.current = false
      // 只在关闭确实把焦点丢到 body 时才重新停放；操作者停在别处（幸存的行）的
      // 焦点归他所有。
      if (document.activeElement !== document.body) return
      const zone = editZoneRef.current
      /* v8 ignore next -- 收窄守卫：编辑器刚关闭时 crumb 模式必然渲染编辑区。 */
      if (zone === null) return
      zone.focus()
    }
  })

  /** 打开路径编辑器：预填尾随分隔符，键入立刻接着子项名。 */
  const openPathEditor = useCallback(() => {
    // 打开编辑器取代在飞列举：先落地的结果会经 navigate 的草稿重置关掉它。
    supersede()
    setLoading(false)
    previewSuspended.current = false
    // 没有列出的层级时无可预填（编辑器正是主目录列举失败后的出路）。
    if (parent === null) {
      setPathDraft('')
      return
    }
    const base = selected?.path ?? parent.path
    const sep = separatorOf(parent)
    setPathDraft(base.endsWith(sep) ? base : `${base}${sep}`)
  }, [supersede, parent, selected])

  /** 编辑草稿：取代在飞导航，并解除提交对草稿跟随的占用。 */
  const editDraft = useCallback((value: string) => {
    supersede()
    setLoading(false)
    previewSuspended.current = false
    setPathDraft(value)
  }, [supersede])

  /** 提交草稿：只挡全空白，Host 拿到原样的文本。 */
  const submitDraft = useCallback(() => {
    if (pathDraft === null || pathDraft.trim() === '') return
    // 成功会卸载仍在聚焦的输入框，先把焦点停到回来的 crumb 编辑区。
    refocusEditZone.current = true
    // 提交的路径独占视图：挂着的防抖计时器否则会取代这次导航。
    previewSuspended.current = true
    navigate(pathDraft)
  }, [pathDraft, navigate])

  /** Escape：输入框持有焦点时先把焦点交给编辑区，再取消编辑。 */
  const escapePathEdit = useCallback(() => {
    // 赋值而非条件设置：顺带退休失败或仍在升级的 Enter 留下的过期标记。
    refocusEditZone.current = document.activeElement === pathInputRef.current
    cancelPathEdit()
  }, [cancelPathEdit])

  /** 焦点离开卡片：像 Escape 一样取消，但不重新停放焦点。 */
  const leavePathEdit = useCallback(() => {
    // 用户自己把焦点移出卡片：取消，且不靠残留的 Enter 失败标记抢焦点。
    refocusEditZone.current = false
    cancelPathEdit()
  }, [cancelPathEdit])

  /** 切换「显示隐藏文件」（纯客户端过滤）。 */
  const toggleHidden = useCallback(() => { setShowHidden(prev => !prev) }, [])

  /** 新建成功后：重新落地目标层，并把它新建的文件夹设为选中。 */
  const landCreated = useCallback((parentPath: string, created: DirectoryEntry) => {
    const { seq, scan } = launchListing(parentPath)
    setLoading(true)
    // 与 navigate/select 对称：新扫描清掉过期的失败文本。
    setError(null)
    scan.then((level) => {
      /* v8 ignore next -- 与 navigate/select 同一道栅栏；拟态框挡住可取代的输入 */
      if (seq !== requestSeq.current) return
      setParent(level)
      setLoading(false)
      select(created)
    }, (reason: unknown) => {
      /* v8 ignore next -- 与 navigate/select 同一道栅栏；拟态框挡住可取代的输入 */
      if (seq !== requestSeq.current) return
      setLoading(false)
      setError(failureText(reason))
    })
  }, [launchListing, select])

  /**
   * 行级写操作成功后重扫那一行所属的一栏。行在右栏时重扫选中目录的内容、选中
   * 不变；行在左栏时重扫当前层，并按 `nextSelectionPath` 恢复或清空选中（清空
   * 即退回单栏——删除选中目录之后的「回到父层」）。
   */
  const refreshEntryLevel = useCallback((entryPath: string, nextSelectionPath: string | null) => {
    const { parent: level, child: inner } = viewRef.current
    if (level === null) { navigate(); return }
    // 该行在右栏（选中目录的内容）时，要重扫的是那一层；否则就是左栏当前层。
    const innerLevel = inner !== null && [...inner.entries, ...inner.files].some(row => row.path === entryPath)
      ? inner
      : null
    const { seq, scan } = launchListing(innerLevel?.path ?? level.path)
    setLoading(true)
    setError(null)
    scan.then((next) => {
      if (seq !== requestSeq.current) return
      if (innerLevel !== null) {
        setChild(next)
        setLoading(false)
        return
      }
      setParent(next)
      setChild(null)
      setSelected(null)
      setLoading(false)
      if (nextSelectionPath === null) return
      const entry = next.entries.find(row => row.path === nextSelectionPath)
      if (entry !== undefined) select(entry)
    }, (reason: unknown) => {
      if (seq !== requestSeq.current) return
      setLoading(false)
      setError(failureText(reason))
    })
  }, [launchListing, navigate, select])

  return {
    parent,
    selected,
    child,
    loading,
    slowScan,
    error,
    pathDraft,
    showHidden,
    crumbs,
    typedPrefix,
    targetPath,
    targetName,
    draftPending: pathDraft !== null,
    generation: openGeneration,
    crumbTrailRef,
    millerRowRef,
    pathInputRef,
    editZoneRef,
    compositionGuard,
    composingRef,
    toggleHidden,
    navigate,
    select,
    advance,
    openPathEditor,
    editDraft,
    submitDraft,
    escapePathEdit,
    leavePathEdit,
    landCreated,
    refreshEntryLevel,
  }
}
