/**
 * 应用内工作区目录浏览器（figma Harness 813-23126 家族）：680×500 对话框（在
 * 较矮/较窄视口上收边——Miller 行横向滚动，两个分栏各自纵向滚动），头部承载
 * 标题、选中路径面包屑与点击即编辑的路径区；下方是 Miller 视图——未选中行时
 * 一整栏，选中后均分为「层级 | 选中文件夹的子项」两栏。导航的时序在
 * {@link useMillerNavigation}，行与文件行在 {@link LevelColumn}，三个拟态框在
 * {@link CreateFolderDialog}/{@link RenameDialog}/{@link DeleteDialog}；本组件
 * 只负责把它们的状态接起来、持有行级写操作（新建/改名/删除）与成功提示。
 *
 * 挑选语义只接受目录：文件行是只读展示。「新建文件夹」把选中的文件夹（否则当前
 * 层）作为目标；「打开」采纳选中的文件夹，回落当前层。隐藏条目由 Host 标记、
 * 默认隐藏，页脚的「显示隐藏文件」开关只在客户端过滤。行级重命名/删除在悬停或
 * 键盘聚焦时露出：重命名在框内校验后调 RPC，失败留在框内；删除必须二次确认，
 * 取消不产生任何写调用。成功各用一次 Toast 提示，并刷新对应的一栏。
 */
import { useCallback, useEffect, useState } from 'react'
import clsx from 'clsx'
import {
  Button, IconCheckOutline16, IconChevronRightOutline14, IconEditOutline16, IconPlusOutline16, Modal, Toast,
} from 'coding-client-ui-primitives'
import type { Translate } from 'coding-client-locale/client'
import type { DirectoryEntry, DirectoryListing } from 'coding-client-runtime/client'
import { LevelColumn } from './DirectoryColumn.tsx'
import { CreateFolderDialog, DeleteDialog, RenameDialog, renameDraftError } from './EntryDialogs.tsx'
import { failureText } from './paths.ts'
import { useMillerNavigation } from './useMillerNavigation.ts'
import css from './DirectoryBrowser.module.css'

/** 持有者给出的浏览器 props：浏览调用、挑选语义与文案。 */
export interface DirectoryBrowserProps {
  /** 对话框可见性（owner 本地状态；关闭只复位、不卸载）。 */
  open: boolean
  /** 列举一层目录（省略路径即 Host 主目录）；signal 用于中断被取代的扫描。 */
  listDirectory: (path?: string, signal?: AbortSignal) => Promise<DirectoryListing>
  /** 在已存在的父目录下新建一个子目录。 */
  createDirectory: (path: string, name: string) => Promise<string>
  /** 在同一父目录下改名（目录或文件），返回新的绝对路径。 */
  renameEntry: (path: string, nextName: string) => Promise<string>
  /** 删除条目（文件，或连同内容的目录）。破坏性：只有拟态框确认之后才会被调用。 */
  removeEntry: (path: string) => Promise<void>
  /** 操作者确认了一个目录（选中项，否则当前层）。 */
  onOpen: (path: string) => void
  /** 不带挑选地关闭（遮罩、Escape、取消）。 */
  onClose: () => void
  /** owner 的确认在飞：打开按钮禁用，视图冻结。 */
  busy: boolean
  /** 本地化文案。 */
  t: Translate
}

/**
 * 渲染目录浏览器对话框。
 * @param props - 由 owner 控制的浏览器 props。
 * @returns 对话框元素（关闭时为 null）。
 */
export function DirectoryBrowser({
  open, listDirectory, createDirectory, renameEntry, removeEntry, onOpen, onClose, busy, t,
}: DirectoryBrowserProps) {
  const nav = useMillerNavigation({ open, listDirectory, t })
  // 新建文件夹：null = 关闭；字符串 = 拟态框草稿。
  const [folderDraft, setFolderDraft] = useState<string | null>(null)
  const [creatingFolder, setCreatingFolder] = useState(false)
  const [createError, setCreateError] = useState<string | null>(null)
  // 重命名：目标条目 + 草稿（预填当前名称）。
  const [renameTarget, setRenameTarget] = useState<DirectoryEntry | null>(null)
  const [renameDraft, setRenameDraft] = useState('')
  const [renaming, setRenaming] = useState(false)
  const [renameError, setRenameError] = useState<string | null>(null)
  // 删除：目标条目 + 确认状态。
  const [deleteTarget, setDeleteTarget] = useState<DirectoryEntry | null>(null)
  const [deleting, setDeleting] = useState(false)
  const [deleteError, setDeleteError] = useState<string | null>(null)
  // 成功提示（共享 Toast）：一次操作只提示一次，淡出后自己消失。
  const [toast, setToast] = useState<string | null>(null)

  // 每次打开/关闭都清掉拟态框状态：上一轮的草稿与错误不跨轮存活。
  useEffect(() => {
    setFolderDraft(null)
    setCreatingFolder(false)
    setCreateError(null)
    setRenameTarget(null)
    setRenaming(false)
    setRenameError(null)
    setDeleteTarget(null)
    setDeleting(false)
    setDeleteError(null)
    setToast(null)
  }, [open])

  /** 该行是不是目录：只有目录参与选中与下潜，也才需要「连同内容删除」的提示。 */
  const isDirectoryPath = useCallback((path: string): boolean => (
    [...(nav.parent?.entries ?? []), ...(nav.child?.entries ?? [])].some(entry => entry.path === path)
  ), [nav.parent, nav.child])

  const confirmCreate = (): void => {
    // 重入栅栏：拟态框只在有目标时渲染，且创建期间按钮禁用。
    if (nav.targetPath === null || folderDraft === null || creatingFolder) return
    // 只挡全空白草稿；Host 拿到原始拼写——后端接受任何非空白的单段名，这里
    // trim 会建出（并选中）另一个同级目录。
    const name = folderDraft
    if (name.trim() === '') return
    setCreatingFolder(true)
    setCreateError(null)
    const generation = nav.generation.current
    createDirectory(nav.targetPath, name).then((createdPath) => {
      // 已关闭（甚至已重新打开）的流程回来的落地不得改动新对话框，也不得对着
      // 过期目标再列举一次。
      if (generation !== nav.generation.current) return
      setCreatingFolder(false)
      setFolderDraft(null)
      nav.landCreated(nav.targetPath ?? '', { name, path: createdPath, hidden: false })
    }, (reason: unknown) => {
      if (generation !== nav.generation.current) return
      setCreatingFolder(false)
      setCreateError(failureText(reason))
    })
  }

  const confirmRename = (): void => {
    if (renameTarget === null || renaming) return
    // 框内已做同样的校验，这里是第二道栅栏（Enter 之外的路径也不许绕过）。
    if (renameDraftError(renameDraft) !== null) return
    const target = renameTarget
    const nextName = renameDraft
    setRenaming(true)
    setRenameError(null)
    const generation = nav.generation.current
    renameEntry(target.path, nextName).then((renamedPath) => {
      if (generation !== nav.generation.current) return
      setRenaming(false)
      setRenameTarget(null)
      setToast(t('browser.renamed', { name: nextName }))
      // 目录改名后视图保持/切到它（重命名完就能继续往里走）；文件行不参与选中，
      // 只刷新所在层并保住原有的目录选中。
      const keep = isDirectoryPath(target.path) ? renamedPath : nav.selected?.path ?? null
      nav.refreshEntryLevel(target.path, keep)
    }, (reason: unknown) => {
      if (generation !== nav.generation.current) return
      setRenaming(false)
      setRenameError(failureText(reason))
    })
  }

  const confirmDelete = (): void => {
    if (deleteTarget === null || deleting) return
    const target = deleteTarget
    setDeleting(true)
    setDeleteError(null)
    const generation = nav.generation.current
    removeEntry(target.path).then(() => {
      if (generation !== nav.generation.current) return
      setDeleting(false)
      setDeleteTarget(null)
      setToast(t('browser.deleted', { name: target.name }))
      // 删掉当前选中的目录就回到父层；其它情况保住原选中。
      const keep = target.path === nav.selected?.path ? null : nav.selected?.path ?? null
      nav.refreshEntryLevel(target.path, keep)
    }, (reason: unknown) => {
      if (generation !== nav.generation.current) return
      setDeleting(false)
      setDeleteError(failureText(reason))
    })
  }

  if (!open) return null
  const twoPane = nav.selected !== null
  // 嵌套拟态框打开时占用交互：Modal 没有焦点陷阱，父级控件（Shift-Tab 或辅助
  // 技术）不得在它下面关闭、采纳或改目标。
  const nestedDialogOpen = folderDraft !== null || renameTarget !== null || deleteTarget !== null
  const parentInert = busy || nestedDialogOpen

  return (
    <Modal
      open={open}
      // Escape 与遮罩会到达每个挂载中的 Modal 的 document 监听；嵌套拟态框在时
      // 只有最上层可以关闭（它们各自的忙碌栅栏会挡住进行中的请求），而进行中的
      // 采纳会钉住流程——关掉它会让 owner 的 createWorkspace 在一次表面取消之后
      // 才落地。
      onClose={() => { if (!nestedDialogOpen && !busy) onClose() }}
      title={t('browser.title')}
      className={clsx(css.dialog)}
      headless
    >
      {/* 路径编辑的取消在卡片作用域观察，而不是输入框：一旦 Tab 停到被过滤的行，
        * 输入框就不在事件路径上，而 Escape 仍必须收起编辑器（不是对话框），
        * 更远的焦点移动也仍必须取消。display:contents 让 header/content/footer
        * 继续作为 Modal 卡片的直接 flex 子项。 */}
      <div
        className={css.editorScope}
        onKeyDown={(event) => {
          if (event.key !== 'Escape' || nav.pathDraft === null) return
          // stopPropagation 让卡片作用域的 Escape 到不了 Modal 的 document 监听。
          event.stopPropagation()
          nav.escapePathEdit()
        }}
        // 编辑期间焦点离开这张卡片就等同于 Escape。不受理的路径：窗口/标签页
        // 失焦（document 已不聚焦）；仍留在卡片内的焦点移动（Tab 到被过滤的行或
        // 页脚开关）；指针路径——编辑时行与开关在 mousedown 上抑制抢焦点，点击
        // 因此能先落地。Enter 在导航在飞期间把焦点留在输入框里，因此提交的路径
        // 不会在这里被撤回。锚定到本卡片（closest），而不是任意 [role="dialog"]，
        // 于是焦点逃到同级覆盖层也会取消。
        onBlur={(event) => {
          if (nav.pathDraft === null) return
          if (!document.hasFocus()) return
          const card = event.currentTarget.closest('[role="dialog"]')
          /* v8 ignore next -- 收窄守卫：这个作用域总在 Modal 卡片内渲染。 */
          if (card === null) return
          if (event.relatedTarget instanceof Node && card.contains(event.relatedTarget)) return
          nav.leavePathEdit()
        }}
      >
        <div className={css.header}>
          <h2 className={css.title}>{t('browser.title')}</h2>
          <div className={css.crumbBar}>
            {nav.pathDraft === null
              ? (
                <>
                  <span className={css.crumbTrail} role="navigation" ref={nav.crumbTrailRef}>
                    {nav.crumbs.map((crumb, index) => (
                      <span key={crumb.path} className={css.crumbSeat}>
                        {index > 0 && <IconChevronRightOutline14 size={12} className={css.crumbChevron} />}
                        <button
                          type="button"
                          className={css.crumb}
                          disabled={parentInert}
                          onClick={() => { nav.navigate(crumb.path) }}
                        >
                          {crumb.name}
                        </button>
                      </span>
                    ))}
                  </span>
                  {/* 面包屑右侧的空白区就是路径编辑入口：整条剩余部分点击即进入
                    * 编辑，栏右端的铅笔图形（带同一 tooltip）是它的标记——一个
                    * 需要操作者去猜的隐形目标，是唯一能进到「键入路径」的路。 */}
                  <button
                    type="button"
                    className={css.crumbEditZone}
                    aria-label={t('browser.editPath')}
                    title={t('browser.editPath')}
                    // 没有列出的层级时仍然可用：主目录列举本身失败时，键入绝对
                    // 路径就是唯一剩下的出路。
                    disabled={parentInert}
                    ref={nav.editZoneRef}
                    onClick={nav.openPathEditor}
                  >
                    <IconEditOutline16 size={14} className={css.crumbEditGlyph} />
                  </button>
                </>
              )
              : (
                <input
                  className={css.pathInput}
                  value={nav.pathDraft}
                  aria-label={t('browser.editPath')}
                  autoFocus
                  ref={nav.pathInputRef}
                  disabled={parentInert}
                  onChange={(event) => { nav.editDraft(event.target.value) }}
                  {...nav.compositionGuard}
                  // Escape 与焦点离开的取消在卡片作用域的包装上（Tab 到行之后也
                  // 必须生效）；这个处理只负责提交。
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' && !nav.composingRef.current) {
                      event.preventDefault()
                      nav.submitDraft()
                    }
                  }}
                />
              )}
          </div>
        </div>
        <div className={css.content}>
          <div className={css.millerRow} ref={nav.millerRowRef}>
            {nav.parent !== null && (
              <LevelColumn
                entries={nav.parent.entries}
                files={nav.parent.files}
                selectedPath={nav.selected?.path ?? null}
                busy={parentInert}
                onPick={nav.select}
                onRename={(entry) => { setRenameTarget(entry); setRenameDraft(entry.name); setRenameError(null) }}
                onDelete={(entry) => {
                  setDeleteTarget(entry)
                  setDeleteError(null)
                }}
                showHidden={nav.showHidden}
                filterPrefix={nav.child === null ? nav.typedPrefix : null}
                pathEditing={nav.draftPending}
                t={t}
              />
            )}
            {twoPane && <span className={css.divider} />}
            {twoPane && nav.child !== null && (
              <LevelColumn
                entries={nav.child.entries}
                files={nav.child.files}
                selectedPath={null}
                busy={parentInert}
                onPick={nav.advance}
                onRename={(entry) => { setRenameTarget(entry); setRenameDraft(entry.name); setRenameError(null) }}
                onDelete={(entry) => {
                  setDeleteTarget(entry)
                  setDeleteError(null)
                }}
                showHidden={nav.showHidden}
                filterPrefix={nav.typedPrefix}
                pathEditing={nav.draftPending}
                t={t}
              />
            )}
          </div>
          {nav.loading && nav.slowScan
          && <div className={clsx(css.status, css.loadingFloat)} role="status">{t('browser.loading')}</div>}
          {/* 后端把一层截在完整结果上限：任何可见栏被截断时都要说出来，而不是让
            * 巨大目录的尾部无声消失。提示描述的是屏幕上的栏，因此在飞扫描不去动
            * 它——在旧视图仍显示被截层级时藏起它，会让每次离开该层的导航都挪动
            * 分栏。 */}
          {(nav.parent?.truncated === true || nav.child?.truncated === true)
          && <div className={css.status} role="status">{t('browser.truncated')}</div>}
          {nav.error !== null && <div className={css.error} role="alert">{nav.error}</div>}
        </div>
        <div className={css.footerBar}>
          <Button
            variant="outline"
            icon={<IconPlusOutline16 size={14} />}
            disabled={nav.parent === null || nav.loading || parentInert || nav.draftPending}
            onClick={() => {
              setFolderDraft('')
              setCreateError(null)
            }}
          >
            {t('browser.newFolder')}
          </Button>
          <button
            type="button"
            className={clsx(css.showHiddenToggle, nav.showHidden && css.showHiddenToggleActive)}
            aria-pressed={nav.showHidden}
            disabled={parentInert}
            // 开关与路径编辑器是组合关系（点开头的前缀与这个过滤会叠加）：编辑期
            // 间不抢焦点，切一下不会把正在想的草稿 blur 掉。非编辑时保持原生行为。
            onMouseDown={nav.draftPending ? (event) => { event.preventDefault() } : undefined}
            onClick={nav.toggleHidden}
          >
            {t('browser.showHidden')}
            {/* 尾部勾选（Menu 的选中词汇）：按下状态切换时标签不位移。 */}
            {nav.showHidden && <IconCheckOutline16 size={14} />}
          </button>
          <span className={css.footerGap} />
          <Button variant="outline" className={clsx(css.footerAction)} disabled={parentInert} onClick={onClose}>{t('browser.cancel')}</Button>
          <Button
            variant="primary"
            className={clsx(css.footerAction)}
            disabled={nav.targetPath === null || nav.loading || parentInert || nav.draftPending}
            /* v8 ignore next -- 收窄守卫：没有目标时打开按钮是禁用的。 */
            onClick={() => { if (nav.targetPath !== null) onOpen(nav.targetPath) }}
          >
            {t('browser.open')}
          </Button>
        </div>
      </div>
      <CreateFolderDialog
        open={folderDraft !== null}
        targetName={nav.targetName}
        value={folderDraft ?? ''}
        busy={creatingFolder}
        error={createError}
        onChange={setFolderDraft}
        onCancel={() => { setFolderDraft(null) }}
        onConfirm={confirmCreate}
        t={t}
      />
      <RenameDialog
        open={renameTarget !== null}
        entryName={renameTarget?.name ?? ''}
        value={renameDraft}
        busy={renaming}
        error={renameError}
        onChange={setRenameDraft}
        onCancel={() => { setRenameTarget(null) }}
        onConfirm={confirmRename}
        t={t}
      />
      <DeleteDialog
        open={deleteTarget !== null}
        entryName={deleteTarget?.name ?? ''}
        isDirectory={deleteTarget !== null && isDirectoryPath(deleteTarget.path)}
        busy={deleting}
        error={deleteError}
        onCancel={() => { setDeleteTarget(null) }}
        onConfirm={confirmDelete}
        t={t}
      />
      {toast !== null && <Toast text={toast} onDone={() => { setToast(null) }} />}
    </Modal>
  )
}
