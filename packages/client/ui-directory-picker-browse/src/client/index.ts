/**
 * Browser half of the browse directory-picker backend: fills ui-workspace's
 * two directory-flow holes with the in-app Select Workspace Directory dialog
 * (figma `Harness` 813-23126 family), driving the node half's
 * `host.listDirectory`/`host.createDirectory` primitives. Mounting this
 * package therefore composes both sides of the browse interaction with one
 * cordis.yml row; no client code branches on a capability kind. The dialog's
 * copy is locale-registered here — the flow package owns its own strings.
 */
import type { ClientContext } from 'coding-client-runtime/client'
// 仅类型引入：拉入欢迎页与既有工作区入口声明的目录流槽位。
import type {} from 'coding-client-ui-workspace/client'
import type {} from 'coding-client-ui-ide/client'
import type { BrowseFlowInjected } from './flow.ts'
import { BrowseDirectoryFlow } from './flow.ts'

/** Locale namespace owning the browser dialog's copy. */
const LOCALE_NS = 'directory-browser'

/** 必需服务：slot 注册表、工作区服务与本地化服务。 */
export const inject = ['slots', 'workspaces', 'locale']

/**
 * 注册目录对话框词典和浏览流。工作区入口可能稍后激活或重新声明，
 * 因此通过 `slots.inject()` 等待对应槽位。
 * @param ctx - Client 根 Context。
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => {
    // 两份词典作为一组注册；第二份遇到冲突时先回滚第一份，
    // 激活失败不能占用同一命名空间里的其他词典。
    const disposers: (() => void)[] = []
    const dictionaries: [locale: string, dict: Record<string, string>][] = [
      ['zh', {
        'browser.title': '选择工作区目录',
        'browser.home': '主目录',
        'browser.newFolder': '新建文件夹',
        'browser.folderName': '文件夹名称',
        'browser.createIn': '在"{name}"中新建文件夹',
        'browser.untitledFolder': '未命名文件夹',
        'browser.create': '创建',
        'browser.cancel': '取消',
        'browser.open': '打开',
        'browser.editPath': '编辑路径',
        'browser.loading': '加载中…',
        'browser.truncated': '条目过多，仅显示开头部分。',
        'browser.showHidden': '显示隐藏文件',
        'browser.rename': '重命名',
        'browser.renameTitle': '重命名',
        'browser.renameFor': '重命名"{name}"',
        'browser.renameLabel': '新名称',
        'browser.renameRequired': '名称不能为空。',
        'browser.renameNoSeparator': '名称不能包含 “/” 或 “\\”。',
        'browser.renameEntry': '重命名"{name}"',
        'browser.save': '保存',
        'browser.renamed': '已重命名"{name}"。',
        'browser.delete': '删除',
        'browser.deleteTitle': '删除',
        'browser.deleteEntry': '删除"{name}"',
        'browser.deleteBody': '确定要删除"{name}"吗？',
        'browser.deleteDirBody': '将连同其中全部内容删除，且无法撤销。',
        'browser.deleteConfirm': '删除',
        'browser.deleted': '已删除"{name}"。',
      }],
      ['en', {
        'browser.title': 'Select Workspace Directory',
        'browser.home': 'Home',
        'browser.newFolder': 'New folder',
        'browser.folderName': 'Folder name',
        'browser.createIn': 'New folder in "{name}"',
        'browser.untitledFolder': 'Untitled folder',
        'browser.create': 'Create',
        'browser.cancel': 'Cancel',
        'browser.open': 'Open',
        'browser.editPath': 'Edit path',
        'browser.loading': 'Loading…',
        'browser.truncated': 'Too many entries to list; only the beginning is shown.',
        'browser.showHidden': 'Show hidden files',
        'browser.rename': 'Rename',
        'browser.renameTitle': 'Rename',
        'browser.renameFor': 'Rename "{name}"',
        'browser.renameLabel': 'New name',
        'browser.renameRequired': 'A name is required.',
        'browser.renameNoSeparator': 'The name cannot contain "/" or "\\".',
        'browser.renameEntry': 'Rename "{name}"',
        'browser.save': 'Save',
        'browser.renamed': 'Renamed "{name}".',
        'browser.delete': 'Delete',
        'browser.deleteTitle': 'Delete',
        'browser.deleteEntry': 'Delete "{name}"',
        'browser.deleteBody': 'Delete "{name}"?',
        'browser.deleteDirBody': 'Everything inside it is deleted as well, and this cannot be undone.',
        'browser.deleteConfirm': 'Delete',
        'browser.deleted': 'Deleted "{name}".',
      }],
    ]
    try {
      for (const [locale, dict] of dictionaries) disposers.push(ctx.locale.register(LOCALE_NS, locale, dict))
    } catch (error) {
      for (const dispose of disposers.reverse()) dispose()
      throw error
    }
    return () => { for (const dispose of disposers) dispose() }
  }, 'directory-picker-browse: dialog dictionaries')

  const injected = (): BrowseFlowInjected => ({
    listDirectory: (path, signal) => ctx.workspaces.listDirectory(path, signal),
    createDirectory: (path, name) => ctx.workspaces.createDirectory(path, name),
    renameEntry: (path, nextName) => ctx.workspaces.renameDirectoryEntry(path, nextName),
    removeEntry: path => ctx.workspaces.deleteDirectoryEntry(path),
    t: ctx.locale.bind(LOCALE_NS),
  })
  // 两个既有入口的声明必须同时就绪；生成器让这一组注册原子安装或回滚。
  ctx.slots.inject('conversation.hero.workspace.directoryFlow', () =>
    ctx.slots.inject('sidebar.workspaces.directoryFlow', function* () {
      yield ctx.slots.register({
        name: 'conversation.hero.workspace.directoryFlow', inject: injected,
      }, BrowseDirectoryFlow)
      yield ctx.slots.register({
        name: 'sidebar.workspaces.directoryFlow', inject: injected,
      }, BrowseDirectoryFlow)
    }))
  // 欢迎页是可选入口；它的声明未装载时不能阻塞既有两处工作区入口。
  ctx.slots.inject('shell.ide.welcome.directoryFlow', () => ctx.slots.register({
    name: 'shell.ide.welcome.directoryFlow', inject: injected,
  }, BrowseDirectoryFlow))
}
