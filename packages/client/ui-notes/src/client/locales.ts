/** 笔记页文案键。 */
export const NS = 'notes'

export type NotesLocaleKey =
  | 'nav' | 'title' | 'space' | 'allNotes' | 'source' | 'assistant'
  | 'search' | 'clearSearch' | 'noMatches' | 'dateLocale'
  | 'view' | 'edit' | 'split' | 'preview' | 'format' | 'inlineCode' | 'list'
  | 'heading' | 'bold' | 'italic' | 'bullets' | 'quote' | 'link'
  | 'welcomeMorning' | 'welcomeAfternoon' | 'welcomeEvening' | 'welcomeDescription'
  | 'loading' | 'newNote' | 'newFolder' | 'noteName' | 'folderName' | 'create' | 'creating' | 'cancel' | 'close' | 'placeholder'
  | 'newNoteIn' | 'newFolderIn' | 'saveLocation' | 'noteCreated' | 'folderCreated' | 'createdRefreshError'
  | 'saved' | 'saving' | 'unsaved' | 'conflict' | 'reload' | 'reloadConfirm' | 'draftKept' | 'discardDraft' | 'retry'
  | 'loadError' | 'saveError' | 'createError' | 'createFolderError' | 'treeError'
  | 'rename' | 'renaming' | 'renameNote' | 'renameFolder' | 'delete' | 'deleteConfirm' | 'deleteFolderConfirm'
  | 'renameEntry' | 'deleteEntry' | 'deleting' | 'deleted' | 'renameError' | 'deleteError'
  | 'copy' | 'copied'
  | 'export' | 'exportMarkdown' | 'exportWord' | 'exportPdf' | 'exportImage' | 'exportPdfHint' | 'exportError'

/** 简体中文文案。 */
export const zh: Record<NotesLocaleKey, string> = {
  nav: '笔记', title: '笔记', space: '笔记目录', allNotes: '全部笔记', source: '原始文本', assistant: 'AI 助手',
  search: '搜索笔记', clearSearch: '清除搜索', noMatches: '找不到匹配的笔记', dateLocale: 'zh-CN',
  view: '正文视图', edit: '编辑', split: '并排', preview: '预览',
  format: '文本格式', inlineCode: '行内代码', list: '待办列表',
  heading: '二级标题', bold: '粗体', italic: '斜体', bullets: '无序列表', quote: '引用', link: '链接',
  welcomeMorning: '早上好呀，新的一天开始啦', welcomeAfternoon: '下午好呀，欢迎回来', welcomeEvening: '晚上好呀，欢迎回来',
  welcomeDescription: '在这里记录你的想法、灵感与工作内容',
  loading: '正在读取笔记…',
  newNote: '新建笔记', newFolder: '新建目录', noteName: '笔记名称', folderName: '目录名称', create: '创建', creating: '正在创建…', cancel: '取消', close: '关闭',
  newNoteIn: '在「{name}」中新建笔记', newFolderIn: '在「{name}」中新建目录',
  saveLocation: '保存到', noteCreated: '笔记已创建', folderCreated: '目录已创建',
  createdRefreshError: '已创建，目录暂未刷新，请稍候。',
  placeholder: '在这里写 Markdown…',
  saved: '已保存', saving: '正在保存…', unsaved: '未保存',
  conflict: '笔记已被外部修改', reload: '重新加载',
  draftKept: '未保存的改动仍保留在编辑器里。', reloadConfirm: '重新加载会舍弃未保存的改动，并读取最新版本。',
  discardDraft: '舍弃并重新加载', retry: '重试保存',
  loadError: '无法读取笔记', saveError: '保存失败',
  createError: '无法创建笔记。请检查名称和保存位置后重试。',
  createFolderError: '无法创建目录。请检查名称和保存位置后重试。', treeError: '无法读取笔记目录',
  rename: '重命名', renaming: '正在重命名…', renameNote: '重命名笔记', renameFolder: '重命名目录', delete: '删除',
  renameEntry: '重命名「{name}」', deleteEntry: '删除「{name}」', deleting: '正在删除…', deleted: '已删除',
  deleteConfirm: '删除笔记「{name}」？此操作不可撤销。',
  deleteFolderConfirm: '删除目录「{name}」及其中的所有文件和子目录？此操作不可撤销。',
  renameError: '无法重命名', deleteError: '无法删除，请重试。',
  copy: '复制', copied: '已复制',
  export: '导出', exportMarkdown: 'Markdown（.md）', exportWord: 'Word（.docx）',
  exportPdf: 'PDF（打印保存）', exportImage: '图片（.png）',
  exportPdfHint: '在打印对话框里选择「另存为 PDF」保存', exportError: '导出失败',
}

/** 英文文案。 */
export const en: Record<NotesLocaleKey, string> = {
  nav: 'Notes', title: 'Notes', space: 'Note directory', allNotes: 'All notes', source: 'Plain text', assistant: 'AI Assistant',
  search: 'Search notes', clearSearch: 'Clear search', noMatches: 'No matching notes', dateLocale: 'en-US',
  view: 'Note view', edit: 'Edit', split: 'Split', preview: 'Preview',
  format: 'Formatting', inlineCode: 'Inline code', list: 'Task list',
  heading: 'Level 2 heading', bold: 'Bold', italic: 'Italic', bullets: 'Bulleted list', quote: 'Quote', link: 'Link',
  welcomeMorning: 'Good morning! A new day begins', welcomeAfternoon: 'Good afternoon! Welcome back', welcomeEvening: 'Good evening! Welcome back',
  welcomeDescription: 'A place for your thoughts, ideas, and work',
  loading: 'Loading notes…',
  newNote: 'New note', newFolder: 'New folder', noteName: 'Note name', folderName: 'Folder name', create: 'Create', creating: 'Creating…', cancel: 'Cancel', close: 'Close',
  newNoteIn: 'New note in “{name}”', newFolderIn: 'New folder in “{name}”',
  saveLocation: 'Save to', noteCreated: 'Note created', folderCreated: 'Folder created',
  createdRefreshError: 'Created. The list will refresh shortly.',
  placeholder: 'Write Markdown here…',
  saved: 'Saved', saving: 'Saving…', unsaved: 'Unsaved',
  conflict: 'Note changed externally', reload: 'Reload',
  draftKept: 'Unsaved changes are still in the editor.', reloadConfirm: 'Reloading discards unsaved changes and opens the latest version.',
  discardDraft: 'Discard and reload', retry: 'Try saving again',
  loadError: 'Could not load the note', saveError: 'Save failed',
  createError: 'Could not create the note. Check the name and location, then try again.',
  createFolderError: 'Could not create the folder. Check the name and location, then try again.', treeError: 'Could not load the note tree',
  rename: 'Rename', renaming: 'Renaming…', renameNote: 'Rename note', renameFolder: 'Rename folder', delete: 'Delete',
  renameEntry: 'Rename “{name}”', deleteEntry: 'Delete “{name}”', deleting: 'Deleting…', deleted: 'Deleted',
  deleteConfirm: 'Delete the note “{name}”? This cannot be undone.',
  deleteFolderConfirm: 'Delete the folder “{name}” and all its files and subfolders? This cannot be undone.',
  renameError: 'Could not rename', deleteError: 'Could not delete. Try again.',
  copy: 'Copy', copied: 'Copied',
  export: 'Export', exportMarkdown: 'Markdown (.md)', exportWord: 'Word (.docx)',
  exportPdf: 'PDF (print to save)', exportImage: 'Image (.png)',
  exportPdfHint: 'Choose "Save as PDF" in the print dialog', exportError: 'Export failed',
}
