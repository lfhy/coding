/** 代码工作区入口文案键。 */
export const NS = 'ide'

export type IdeLocaleKey =
  | 'nav' | 'title' | 'headline' | 'description' | 'openFolder'
  | 'recent' | 'empty' | 'loading' | 'error' | 'entryError' | 'workspaceError'
  | 'files' | 'treeEmpty' | 'treeError' | 'treeTruncated' | 'retry'
  | 'openFiles' | 'unsaved' | 'closeFile' | 'close' | 'editorLabel' | 'plainText' | 'lineColumn'
  | 'tooLarge' | 'unsupported' | 'loadError' | 'conflictKept' | 'draftKept' | 'reload'
  | 'editor' | 'saving' | 'saved' | 'save' | 'saveShortcut' | 'assistant'
  | 'workspaceHeadline' | 'workspaceDescription'
  | 'discardTitle' | 'discardDescription' | 'discard' | 'reloadTitle' | 'reloadDescription' | 'cancel'
  | 'switchWorkspace' | 'openOtherFolder' | 'split' | 'splitHint' | 'paneLabel' | 'closePane' | 'dropLeft' | 'dropRight'

/** 简体中文文案。 */
export const zh: Record<IdeLocaleKey, string> = {
  nav: '代码工作区', title: '代码工作区', headline: '打开一个项目开始编码',
  description: '选择最近的工作区，或者从本机文件夹打开新项目。',
  openFolder: '打开文件夹', recent: '最近打开', empty: '还没有工作区，先打开一个文件夹。',
  loading: '正在读取工作区…', error: '无法读取工作区，请稍后重试。',
  entryError: '无法打开代码工作区，请重试。', workspaceError: '无法打开工作区，请重试。',
  files: '文件', treeEmpty: '这个目录还没有文件。', treeError: '无法读取目录。', treeTruncated: '目录条目较多，仅显示前面部分。',
  retry: '重试', openFiles: '打开的文件', unsaved: '未保存', closeFile: '关闭 {name}', close: '关闭',
  editorLabel: '{name} 编辑器', plainText: '纯文本', lineColumn: '第 {line} 行，第 {column} 列',
  tooLarge: '文件太大，无法在编辑器中打开。', unsupported: '这种文件暂时只能在外部应用中查看。',
  loadError: '无法读取文件，请重试。', conflictKept: '文件已被其他操作修改，当前草稿已保留。', draftKept: '保存失败，当前草稿已保留。',
  reload: '重新载入', editor: '编辑器', saving: '保存中…', saved: '已保存', save: '保存', saveShortcut: '保存（⌘/Ctrl+S）',
  assistant: 'AI 助手', workspaceHeadline: '从左侧选择文件开始编码', workspaceDescription: '文件会在这里打开；右侧助手与当前工作区会话共用上下文。',
  discardTitle: '放弃未保存的更改？', discardDescription: '关闭 {name} 会丢弃当前草稿。', discard: '放弃并关闭',
  reloadTitle: '重新载入文件？', reloadDescription: '重新载入 {name} 会丢弃当前草稿。', cancel: '取消',
  switchWorkspace: '切换工作区', openOtherFolder: '打开其他文件夹…', split: '向右拆分',
  splitHint: '把当前文件拆到新的编辑器分组（也可直接拖动标签）', paneLabel: '编辑器分组 {index}',
  closePane: '关闭编辑器分组 {index}', dropLeft: '在左侧新建分组', dropRight: '在右侧新建分组',
}

/** 英文文案。 */
export const en: Record<IdeLocaleKey, string> = {
  nav: 'Code', title: 'Code workspace', headline: 'Open a project and start coding',
  description: 'Choose a recent workspace or open a new project from a local folder.',
  openFolder: 'Open folder', recent: 'Recent', empty: 'No workspaces yet. Open a folder to get started.',
  loading: 'Loading workspaces…', error: 'Could not load workspaces. Try again later.',
  entryError: 'Could not open the code workspace. Try again.', workspaceError: 'Could not open the workspace. Try again.',
  files: 'Files', treeEmpty: 'This directory is empty.', treeError: 'Could not load this directory.', treeTruncated: 'This directory is large; only the first entries are shown.',
  retry: 'Retry', openFiles: 'Open files', unsaved: 'Unsaved', closeFile: 'Close {name}', close: 'Close',
  editorLabel: '{name} editor', plainText: 'Plain text', lineColumn: 'Ln {line}, Col {column}',
  tooLarge: 'This file is too large to open in the editor.', unsupported: 'This file type can only be opened in an external app for now.',
  loadError: 'Could not read this file. Try again.', conflictKept: 'This file changed elsewhere. Your draft is preserved.', draftKept: 'Saving failed. Your draft is preserved.',
  reload: 'Reload', editor: 'Editor', saving: 'Saving…', saved: 'Saved', save: 'Save', saveShortcut: 'Save (⌘/Ctrl+S)',
  assistant: 'AI assistant', workspaceHeadline: 'Choose a file to start coding', workspaceDescription: 'Files open here; the assistant on the right shares the current workspace session.',
  discardTitle: 'Discard unsaved changes?', discardDescription: 'Closing {name} will discard your draft.', discard: 'Discard and close',
  reloadTitle: 'Reload this file?', reloadDescription: 'Reloading {name} will discard your draft.', cancel: 'Cancel',
  switchWorkspace: 'Switch workspace', openOtherFolder: 'Open another folder…', split: 'Split right',
  splitHint: 'Move this file into a new editor group (or drag the tab)', paneLabel: 'Editor group {index}',
  closePane: 'Close editor group {index}', dropLeft: 'New group on the left', dropRight: 'New group on the right',
}
