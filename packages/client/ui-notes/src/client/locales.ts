/** 笔记页文案键。 */
export const NS = 'notes'

export type NotesLocaleKey =
  | 'nav' | 'title' | 'space' | 'source' | 'preview'
  | 'empty' | 'emptyHint' | 'newNote' | 'noteName' | 'create' | 'cancel' | 'placeholder'
  | 'saved' | 'saving' | 'unsaved' | 'conflict' | 'reload'
  | 'loadError' | 'saveError' | 'createError' | 'treeError'
  | 'copy' | 'copied' | 'codeLabel'

/** 简体中文文案。 */
export const zh: Record<NotesLocaleKey, string> = {
  nav: '笔记', title: '笔记', space: '目录', source: '原始文本', preview: '预览',
  empty: '还没有笔记', emptyHint: '新建一篇笔记，或让 AI 助手帮你起草。',
  newNote: '新建笔记', noteName: '笔记名称', create: '创建', cancel: '取消',
  placeholder: '在这里写 Markdown…',
  saved: '已保存', saving: '正在保存…', unsaved: '有未保存的改动',
  conflict: '笔记已被外部修改', reload: '重新加载',
  loadError: '无法读取笔记', saveError: '保存失败，你的改动仍保留在编辑器里',
  createError: '无法创建笔记', treeError: '无法读取笔记目录',
  copy: '复制', copied: '已复制', codeLabel: '代码',
}

/** 英文文案。 */
export const en: Record<NotesLocaleKey, string> = {
  nav: 'Notes', title: 'Notes', space: 'Tree', source: 'Plain text', preview: 'Preview',
  empty: 'No notes yet', emptyHint: 'Create a note, or let the AI assistant draft one.',
  newNote: 'New note', noteName: 'Note name', create: 'Create', cancel: 'Cancel',
  placeholder: 'Write Markdown here…',
  saved: 'Saved', saving: 'Saving…', unsaved: 'Unsaved changes',
  conflict: 'Note changed externally', reload: 'Reload',
  loadError: 'Could not load the note', saveError: 'Save failed; your edits are kept in the editor',
  createError: 'Could not create the note', treeError: 'Could not load the note tree',
  copy: 'Copy', copied: 'Copied', codeLabel: 'Code',
}
