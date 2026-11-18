/** 笔记页文案键。 */
export const NS = 'notes'

export type NotesLocaleKey =
  | 'nav' | 'title' | 'space' | 'allNotes' | 'source' | 'assistant'
  | 'search' | 'clearSearch' | 'noMatches' | 'dateLocale' | 'noteType' | 'folderType'
  | 'view' | 'edit' | 'split' | 'preview' | 'format' | 'inlineCode' | 'list'
  | 'heading' | 'bold' | 'italic' | 'bullets' | 'quote' | 'link'
  | 'empty' | 'emptyHint' | 'loading' | 'chooseNote' | 'newNote' | 'newFolder' | 'noteName' | 'folderName' | 'create' | 'creating' | 'cancel' | 'close' | 'placeholder'
  | 'saved' | 'saving' | 'unsaved' | 'conflict' | 'reload' | 'reloadConfirm' | 'draftKept' | 'discardDraft' | 'retry'
  | 'loadError' | 'saveError' | 'createError' | 'createFolderError' | 'treeError'
  | 'copy' | 'copied'

/** 简体中文文案。 */
export const zh: Record<NotesLocaleKey, string> = {
  nav: '笔记', title: '笔记', space: '笔记目录', allNotes: '全部笔记', source: '原始文本', assistant: 'AI 助手',
  search: '搜索笔记', clearSearch: '清除搜索', noMatches: '找不到匹配的笔记', dateLocale: 'zh-CN', noteType: 'Markdown', folderType: '目录',
  view: '正文视图', edit: '编辑', split: '并排', preview: '预览',
  format: '文本格式', inlineCode: '行内代码', list: '待办列表',
  heading: '二级标题', bold: '粗体', italic: '斜体', bullets: '无序列表', quote: '引用', link: '链接',
  empty: '还没有笔记', emptyHint: '点击目录顶部的「新建笔记」开始。',
  loading: '正在读取笔记…', chooseNote: '在目录中选择一篇笔记',
  newNote: '新建笔记', newFolder: '新建目录', noteName: '笔记名称', folderName: '目录名称', create: '创建', creating: '正在创建…', cancel: '取消', close: '关闭',
  placeholder: '在这里写 Markdown…',
  saved: '已保存', saving: '正在保存…', unsaved: '未保存',
  conflict: '笔记已被外部修改', reload: '重新加载',
  draftKept: '未保存的改动仍保留在编辑器里。', reloadConfirm: '重新加载会舍弃未保存的改动，并读取最新版本。',
  discardDraft: '舍弃并重新加载', retry: '重试保存',
  loadError: '无法读取笔记', saveError: '保存失败',
  createError: '无法创建笔记', createFolderError: '无法创建目录', treeError: '无法读取笔记目录',
  copy: '复制', copied: '已复制',
}

/** 英文文案。 */
export const en: Record<NotesLocaleKey, string> = {
  nav: 'Notes', title: 'Notes', space: 'Note directory', allNotes: 'All notes', source: 'Plain text', assistant: 'AI Assistant',
  search: 'Search notes', clearSearch: 'Clear search', noMatches: 'No matching notes', dateLocale: 'en-US', noteType: 'Markdown', folderType: 'Folder',
  view: 'Note view', edit: 'Edit', split: 'Split', preview: 'Preview',
  format: 'Formatting', inlineCode: 'Inline code', list: 'Task list',
  heading: 'Level 2 heading', bold: 'Bold', italic: 'Italic', bullets: 'Bulleted list', quote: 'Quote', link: 'Link',
  empty: 'No notes yet', emptyHint: 'Choose New note at the top of the directory to get started.',
  loading: 'Loading notes…', chooseNote: 'Choose a note from the directory',
  newNote: 'New note', newFolder: 'New folder', noteName: 'Note name', folderName: 'Folder name', create: 'Create', creating: 'Creating…', cancel: 'Cancel', close: 'Close',
  placeholder: 'Write Markdown here…',
  saved: 'Saved', saving: 'Saving…', unsaved: 'Unsaved',
  conflict: 'Note changed externally', reload: 'Reload',
  draftKept: 'Unsaved changes are still in the editor.', reloadConfirm: 'Reloading discards unsaved changes and opens the latest version.',
  discardDraft: 'Discard and reload', retry: 'Try saving again',
  loadError: 'Could not load the note', saveError: 'Save failed',
  createError: 'Could not create the note', createFolderError: 'Could not create the folder', treeError: 'Could not load the note tree',
  copy: 'Copy', copied: 'Copied',
}
