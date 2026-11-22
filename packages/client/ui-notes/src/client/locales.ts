/** 笔记页文案键。 */
export const NS = 'notes'

export type NotesLocaleKey =
  | 'nav' | 'title' | 'space' | 'allNotes' | 'source' | 'assistant' | 'openTabs' | 'closeTab'
  | 'search' | 'clearSearch' | 'noMatches' | 'dateLocale'
  | 'view' | 'edit' | 'split' | 'preview' | 'format' | 'inlineCode' | 'list'
  | 'heading' | 'bold' | 'italic' | 'bullets' | 'quote' | 'link'
  | 'welcomeMorning' | 'welcomeAfternoon' | 'welcomeEvening' | 'welcomeDescription'
  | 'newEntry' | 'entryFolder' | 'entryNote' | 'entryPresentation'
  | 'entryMindmap' | 'newMindmap' | 'mindmapName' | 'mindmapCreated' | 'mindmapImported'
  | 'createMindmapError' | 'importMindmapError' | 'renameMindmap' | 'deleteMindmapConfirm'
  | 'entryWord' | 'newWord' | 'wordName' | 'wordCreated' | 'wordImported'
  | 'createWordError' | 'importWordError' | 'renameWord' | 'deleteWordConfirm'
  | 'entryExcel' | 'newExcel' | 'excelName' | 'excelCreated' | 'excelImported'
  | 'createExcelError' | 'importExcelError' | 'renameExcel' | 'deleteExcelConfirm'
  | 'loading' | 'newNote' | 'newFolder' | 'newPresentation' | 'importFile' | 'importText' | 'noteName' | 'folderName' | 'presentationName' | 'create' | 'creating' | 'cancel' | 'close' | 'placeholder'
  | 'newNoteIn' | 'newFolderIn' | 'newSubfolder' | 'newSubfolderIn' | 'saveLocation' | 'noteCreated' | 'folderCreated' | 'presentationCreated' | 'noteImported' | 'presentationImported' | 'createdRefreshError'
  | 'saved' | 'saving' | 'unsaved' | 'conflict' | 'reload' | 'reloadConfirm' | 'draftKept' | 'discardDraft' | 'retry'
  | 'loadError' | 'saveError' | 'createError' | 'createFolderError' | 'createPresentationError' | 'importTextError' | 'importSlideError' | 'treeError'
  | 'rename' | 'renaming' | 'renameNote' | 'renameFolder' | 'renamePresentation' | 'delete' | 'deleteConfirm' | 'deleteFolderConfirm' | 'deletePresentationConfirm'
  | 'renameEntry' | 'deleteEntry' | 'deleting' | 'deleted' | 'renameError' | 'deleteError'
  | 'copy' | 'copied'
  | 'export' | 'exportMarkdown' | 'exportWord' | 'exportPdf' | 'exportImage' | 'exportError'

/** 简体中文文案。 */
export const zh: Record<NotesLocaleKey, string> = {
  nav: '笔记', title: '笔记', space: '笔记目录', allNotes: '全部笔记', source: '原始文本', assistant: 'AI 助手',
  openTabs: '打开的笔记', closeTab: '关闭「{name}」',
  search: '搜索笔记', clearSearch: '清除搜索', noMatches: '找不到匹配的笔记', dateLocale: 'zh-CN',
  view: '正文视图', edit: '编辑', split: '并排', preview: '预览',
  format: '文本格式', inlineCode: '行内代码', list: '待办列表',
  heading: '二级标题', bold: '粗体', italic: '斜体', bullets: '无序列表', quote: '引用', link: '链接',
  welcomeMorning: '早上好呀，新的一天开始啦', welcomeAfternoon: '下午好呀，欢迎回来', welcomeEvening: '晚上好呀，欢迎回来',
  welcomeDescription: '在这里记录你的想法、灵感与工作内容',
  loading: '正在读取笔记…',
  newEntry: '新建', entryFolder: '目录', entryNote: '笔记', entryPresentation: '幻灯片',
  entryMindmap: '思维导图', newMindmap: '新建思维导图', mindmapName: '思维导图名称',
  mindmapCreated: '思维导图已创建', mindmapImported: '思维导图已导入',
  createMindmapError: '无法创建思维导图。请检查名称和保存位置后重试。',
  importMindmapError: '无法导入思维导图。请确认文件是有效的 XMind 或 Coding 思维导图。',
  renameMindmap: '重命名思维导图', deleteMindmapConfirm: '删除思维导图「{name}」？此操作不可撤销。',
  entryWord: 'Word 文档', newWord: '新建 Word 文档', wordName: '文档名称',
  wordCreated: 'Word 文档已创建', wordImported: 'Word 文档已导入',
  createWordError: '无法创建 Word 文档。请检查名称和保存位置后重试。',
  importWordError: '无法导入 Word 文档。请使用不超过 16 MiB、无外部链接的 .docx 文件，并检查是否已有同名笔记。',
  renameWord: '重命名 Word 文档', deleteWordConfirm: '删除 Word 文档「{name}」？此操作不可撤销。',
  entryExcel: 'Excel 表格', newExcel: '新建 Excel 表格', excelName: '表格名称',
  excelCreated: 'Excel 表格已创建', excelImported: 'Excel 表格已导入',
  createExcelError: '无法创建 Excel 表格。请检查名称和保存位置后重试。',
  importExcelError: '无法导入 Excel 表格。请使用不超过 16 MiB、无外部连接的 .xlsx 文件，并检查是否已有同名笔记。',
  renameExcel: '重命名 Excel 表格', deleteExcelConfirm: '删除 Excel 表格「{name}」？此操作不可撤销。',
  newNote: '新建笔记', newFolder: '新建目录', newPresentation: '新建幻灯片', importFile: '导入', importText: '文本', noteName: '笔记名称', folderName: '目录名称', presentationName: '幻灯片名称', create: '创建', creating: '正在创建…', cancel: '取消', close: '关闭',
  newNoteIn: '在「{name}」中新建笔记', newFolderIn: '在「{name}」中新建目录',
  newSubfolder: '新建子目录', newSubfolderIn: '在「{name}」中新建子目录',
  saveLocation: '保存到', noteCreated: '笔记已创建', folderCreated: '目录已创建', presentationCreated: '幻灯片已创建', presentationImported: '幻灯片已导入', noteImported: '笔记已导入',
  createdRefreshError: '已创建，目录暂未刷新，请稍候。',
  placeholder: '在这里写 Markdown…',
  saved: '已保存', saving: '正在保存…', unsaved: '未保存',
  conflict: '笔记已被外部修改', reload: '重新加载',
  draftKept: '未保存的改动仍保留在编辑器里。', reloadConfirm: '重新加载会舍弃未保存的改动，并读取最新版本。',
  discardDraft: '舍弃并重新加载', retry: '重试保存',
  loadError: '无法读取笔记', saveError: '保存失败',
  createError: '无法创建笔记。请检查名称和保存位置后重试。',
  createFolderError: '无法创建目录。请检查名称和保存位置后重试。', createPresentationError: '无法创建幻灯片。请检查名称和保存位置后重试。',
  importTextError: '无法导入该文本。请确认是 UTF-8 编码的 Markdown 或 TXT，且不超过 1 MiB。',
  importSlideError: '无法导入该幻灯片。请确认文件是有效的 .pptx。', treeError: '无法读取笔记目录',
  rename: '重命名', renaming: '正在重命名…', renameNote: '重命名笔记', renameFolder: '重命名目录', renamePresentation: '重命名幻灯片', delete: '删除',
  renameEntry: '重命名「{name}」', deleteEntry: '删除「{name}」', deleting: '正在删除…', deleted: '已删除',
  deleteConfirm: '删除笔记「{name}」？此操作不可撤销。',
  deleteFolderConfirm: '删除目录「{name}」及其中的所有文件和子目录？此操作不可撤销。',
  deletePresentationConfirm: '删除幻灯片「{name}」及其工作文件？此操作不可撤销。',
  renameError: '无法重命名', deleteError: '无法删除，请重试。',
  copy: '复制', copied: '已复制',
  export: '导出', exportMarkdown: 'Markdown（.md）', exportWord: 'Word（.docx）',
  exportPdf: 'PDF（.pdf）', exportImage: '图片（.png）', exportError: '导出失败',
}

/** 英文文案。 */
export const en: Record<NotesLocaleKey, string> = {
  nav: 'Notes', title: 'Notes', space: 'Note directory', allNotes: 'All notes', source: 'Plain text', assistant: 'AI Assistant',
  openTabs: 'Open notes', closeTab: 'Close “{name}”',
  search: 'Search notes', clearSearch: 'Clear search', noMatches: 'No matching notes', dateLocale: 'en-US',
  view: 'Note view', edit: 'Edit', split: 'Split', preview: 'Preview',
  format: 'Formatting', inlineCode: 'Inline code', list: 'Task list',
  heading: 'Level 2 heading', bold: 'Bold', italic: 'Italic', bullets: 'Bulleted list', quote: 'Quote', link: 'Link',
  welcomeMorning: 'Good morning! A new day begins', welcomeAfternoon: 'Good afternoon! Welcome back', welcomeEvening: 'Good evening! Welcome back',
  welcomeDescription: 'A place for your thoughts, ideas, and work',
  loading: 'Loading notes…',
  newEntry: 'New', entryFolder: 'Folder', entryNote: 'Note', entryPresentation: 'Presentation',
  entryMindmap: 'Mind map', newMindmap: 'New mind map', mindmapName: 'Mind map name',
  mindmapCreated: 'Mind map created', mindmapImported: 'Mind map imported',
  createMindmapError: 'Could not create the mind map. Check the name and location, then try again.',
  importMindmapError: 'Could not import the mind map. Use a valid XMind or Coding mind map file.',
  renameMindmap: 'Rename mind map', deleteMindmapConfirm: 'Delete the mind map “{name}”? This cannot be undone.',
  entryWord: 'Word document', newWord: 'New Word document', wordName: 'Document name',
  wordCreated: 'Word document created', wordImported: 'Word document imported',
  createWordError: 'Could not create the Word document. Check the name and location, then try again.',
  importWordError: 'Could not import the Word document. Use a .docx file up to 16 MiB without external links, and check for a note with the same name.',
  renameWord: 'Rename Word document', deleteWordConfirm: 'Delete the Word document “{name}”? This cannot be undone.',
  entryExcel: 'Excel workbook', newExcel: 'New Excel workbook', excelName: 'Workbook name',
  excelCreated: 'Excel workbook created', excelImported: 'Excel workbook imported',
  createExcelError: 'Could not create the Excel workbook. Check the name and location, then try again.',
  importExcelError: 'Could not import the Excel workbook. Use an .xlsx file up to 16 MiB without external connections, and check for a note with the same name.',
  renameExcel: 'Rename Excel workbook', deleteExcelConfirm: 'Delete the Excel workbook “{name}”? This cannot be undone.',
  newNote: 'New note', newFolder: 'New folder', newPresentation: 'New presentation', importFile: 'Import', importText: 'Text', noteName: 'Note name', folderName: 'Folder name', presentationName: 'Presentation name', create: 'Create', creating: 'Creating…', cancel: 'Cancel', close: 'Close',
  newNoteIn: 'New note in “{name}”', newFolderIn: 'New folder in “{name}”',
  newSubfolder: 'New subfolder', newSubfolderIn: 'New subfolder in “{name}”',
  saveLocation: 'Save to', noteCreated: 'Note created', folderCreated: 'Folder created', presentationCreated: 'Presentation created', presentationImported: 'Presentation imported', noteImported: 'Note imported',
  createdRefreshError: 'Created. The list will refresh shortly.',
  placeholder: 'Write Markdown here…',
  saved: 'Saved', saving: 'Saving…', unsaved: 'Unsaved',
  conflict: 'Note changed externally', reload: 'Reload',
  draftKept: 'Unsaved changes are still in the editor.', reloadConfirm: 'Reloading discards unsaved changes and opens the latest version.',
  discardDraft: 'Discard and reload', retry: 'Try saving again',
  loadError: 'Could not load the note', saveError: 'Save failed',
  createError: 'Could not create the note. Check the name and location, then try again.',
  createFolderError: 'Could not create the folder. Check the name and location, then try again.', createPresentationError: 'Could not create the presentation. Check the name and location, then try again.',
  importTextError: 'Could not import that text. Use UTF-8 Markdown or TXT under 1 MiB.',
  importSlideError: 'Could not import that presentation. Make sure the file is a valid .pptx.', treeError: 'Could not load the note tree',
  rename: 'Rename', renaming: 'Renaming…', renameNote: 'Rename note', renameFolder: 'Rename folder', renamePresentation: 'Rename presentation', delete: 'Delete',
  renameEntry: 'Rename “{name}”', deleteEntry: 'Delete “{name}”', deleting: 'Deleting…', deleted: 'Deleted',
  deleteConfirm: 'Delete the note “{name}”? This cannot be undone.',
  deleteFolderConfirm: 'Delete the folder “{name}” and all its files and subfolders? This cannot be undone.',
  deletePresentationConfirm: 'Delete the presentation “{name}” and its working files? This cannot be undone.',
  renameError: 'Could not rename', deleteError: 'Could not delete. Try again.',
  copy: 'Copy', copied: 'Copied',
  export: 'Export', exportMarkdown: 'Markdown (.md)', exportWord: 'Word (.docx)',
  exportPdf: 'PDF (.pdf)', exportImage: 'Image (.png)', exportError: 'Export failed',
}
