/** `open-in-app` 命名空间词典。 */

/** 本插件拥有的词典命名空间。 */
export const NS = 'open-in-app'

const PRODUCT_NAMES = {
  'app.cursor': 'Cursor', 'app.vscode': 'VS Code', 'app.vscodeinsiders': 'VS Code Insiders',
  'app.windsurf': 'Windsurf', 'app.zed': 'Zed', 'app.sublimetext': 'Sublime Text',
  'app.xcode': 'Xcode', 'app.androidstudio': 'Android Studio', 'app.intellij': 'IntelliJ IDEA',
  'app.pycharm': 'PyCharm', 'app.webstorm': 'WebStorm', 'app.phpstorm': 'PhpStorm',
  'app.goland': 'GoLand', 'app.rider': 'Rider', 'app.rustrover': 'RustRover',
  'app.fork': 'Fork', 'app.sourcetree': 'Sourcetree', 'app.github': 'GitHub Desktop',
  'app.tower': 'Tower', 'app.gitkraken': 'GitKraken', 'app.smartgit': 'SmartGit',
  'app.sublimemerge': 'Sublime Merge', 'app.ghostty': 'Ghostty', 'app.warp': 'Warp',
  'app.iterm': 'iTerm2', 'app.kitty': 'kitty', 'app.windowsterminal': 'Windows Terminal',
  'app.gitbash': 'Git Bash', 'app.gnometerminal': 'GNOME Terminal', 'app.konsole': 'Konsole',
} as const

/** 简体中文词典，也是 key 集合的来源。 */
export const zh = {
  'open.title': '在 {app} 中打开工作目录',
  'open.tooltip': '在本地打开',
  'open.error': '打开失败',
  'workbench.open.title': '打开文件工作台',
  'workbench.open.tooltip': '打开内置文件工作台',
  'workbench.label': '文件工作台',
  'workbench.close': '关闭文件工作台',
  'workbench.fullscreen.enter': '最大化文件工作台',
  'workbench.fullscreen.exit': '退出最大化',
  'workbench.bottom.show': '显示终端底栏',
  'workbench.bottom.hide': '隐藏终端底栏',
  'workbench.files.show': '显示文件侧栏',
  'workbench.files.hide': '隐藏文件侧栏',
  'workbench.empty.title': '打开文件',
  'workbench.empty.detail': '从右侧工作区文件树中选择文件',
  'tabs.label': '已打开文件',
  'tabs.close': '关闭 {name}',
  'files.label': '工作区文件',
  'files.filter': '筛选文件…',
  'files.loading': '正在读取目录…',
  'files.empty': '此目录为空',
  'files.error': '无法读取工作区文件',
  'files.retry': '重试',
  'files.truncated': '此目录项目过多，仅显示 Host 返回的部分结果。',
  'files.type.other': '暂不支持此项目类型',
  'preview.loading': '正在读取文件…',
  'preview.error': '无法读取此文件',
  'preview.retry': '重新读取',
  'preview.refresh': '刷新文件',
  'preview.unsupported': '暂不支持预览此文件',
  'preview.unsupported.mime': '暂不支持预览此文件（{mime}）',
  'terminal.label': '终端',
  'terminal.connecting': '正在连接终端…',
  'terminal.connected': '终端已连接',
  'terminal.disconnected': '终端连接已断开',
  'terminal.error': '终端不可用：{message}',
  'terminal.protocolError': '终端返回了无效数据',
  'terminal.exited': '终端已退出（代码 {code}）',
  'terminal.reconnect': '重新连接',
  'menu.toggle': '选择打开方式',
  'menu.aria': '打开方式',
  ...PRODUCT_NAMES,
  'app.finder': '访达', 'app.explorer': '文件资源管理器',
  'app.filemanager': '文件管理器', 'app.terminal': '终端',
} as const

/** 与中文来源保持相同 key 的英文词典。 */
export const en: Record<OpenInAppKey, string> = {
  'open.title': 'Open workspace in {app}',
  'open.tooltip': 'Open locally',
  'open.error': 'Failed to open',
  'workbench.open.title': 'Open file workbench',
  'workbench.open.tooltip': 'Open built-in file workbench',
  'workbench.label': 'File workbench',
  'workbench.close': 'Close file workbench',
  'workbench.fullscreen.enter': 'Maximize file workbench',
  'workbench.fullscreen.exit': 'Exit full screen',
  'workbench.bottom.show': 'Show terminal panel',
  'workbench.bottom.hide': 'Hide terminal panel',
  'workbench.files.show': 'Show files sidebar',
  'workbench.files.hide': 'Hide files sidebar',
  'workbench.empty.title': 'Open a file',
  'workbench.empty.detail': 'Choose a file from the workspace tree on the right',
  'tabs.label': 'Open files',
  'tabs.close': 'Close {name}',
  'files.label': 'Workspace files',
  'files.filter': 'Filter files…',
  'files.loading': 'Loading directory…',
  'files.empty': 'This directory is empty',
  'files.error': 'Workspace files are unavailable',
  'files.retry': 'Retry',
  'files.truncated': 'This directory has too many items; only the Host result is shown.',
  'files.type.other': 'This item type is not supported',
  'preview.loading': 'Loading file…',
  'preview.error': 'This file could not be read',
  'preview.retry': 'Read again',
  'preview.refresh': 'Refresh file',
  'preview.unsupported': 'This file cannot be previewed yet',
  'preview.unsupported.mime': 'This file cannot be previewed yet ({mime})',
  'terminal.label': 'Terminal',
  'terminal.connecting': 'Connecting to terminal…',
  'terminal.connected': 'Terminal connected',
  'terminal.disconnected': 'Terminal connection closed',
  'terminal.error': 'Terminal unavailable: {message}',
  'terminal.protocolError': 'The terminal returned invalid data',
  'terminal.exited': 'Terminal exited (code {code})',
  'terminal.reconnect': 'Reconnect',
  'menu.toggle': 'Choose an app to open in',
  'menu.aria': 'Open in',
  ...PRODUCT_NAMES,
  'app.finder': 'Finder', 'app.explorer': 'File Explorer',
  'app.filemanager': 'Files', 'app.terminal': 'Terminal',
}

/** `open-in-app` 命名空间的 key 域。 */
export type OpenInAppKey = keyof typeof zh

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** 工作区打开、文件工作台与终端文案。 */
    'open-in-app': OpenInAppKey
  }
}
