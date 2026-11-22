/** 文件选择器按类型隔离扩展名和读取方式，写入后的刷新与打开仍由笔记页负责。 */
import type { PropsLocale } from 'coding-client-ui-slots'
import type { NotesLocaleKey, NS } from './locales.ts'
import type { OfficeKind } from './notes-tree.ts'
import { notesCreate, notesImportMindmap, notesImportOffice, notesImportSlide } from './wire.ts'

const TEXT_MAX_BYTES = 1024 * 1024

/** 去掉最后一段扩展名；包含点号的文件名仍保留此前的部分。 */
function stem(name: string): string {
  return name.replace(/\.[^.]+$/u, '').trim()
}

type RunImport = (task: () => Promise<string>, done: NotesLocaleKey, failed: NotesLocaleKey) => Promise<void>

/** 菜单与隐藏文件选择器共用类型键。 */
export type NoteImportKind = 'text' | 'slides' | 'mindmap' | OfficeKind
export type NoteImportPicker = { accept: string; onFile: (file: File | undefined) => void }

/**
 * 为每个导入入口提供选择器配置与一次性导入动作。
 * @param sessionId - 幻灯片宿主校验所需的笔记会话。
 * @param t - 笔记文案。
 * @param run - 页面持有的导入事务。
 * @param notify - 拒绝选中文件时的提示。
 * @returns 每种导入类型的扩展名筛选和回调。
 */
export function noteImportPickers(
  sessionId: string,
  t: PropsLocale<typeof NS>['t'],
  run: RunImport,
  notify: (key: NotesLocaleKey) => void,
): Record<NoteImportKind, NoteImportPicker> {
  const picker = (
    accept: string, load: (file: File) => Promise<{ path: string }>, done: NotesLocaleKey, failed: NotesLocaleKey,
  ) => ({
    accept,
    onFile(file: File | undefined) {
      if (file === undefined) return
      const extension = /\.[^.]+$/u.exec(file.name)?.[0]?.toLowerCase()
      if (extension === undefined || !accept.split(',').includes(extension)) { notify(failed); return }
      void run(async () => (await load(file)).path, done, failed)
    },
  })
  return {
    text: picker('.md,.markdown,.txt', async (file) => {
      if (file.size > TEXT_MAX_BYTES) throw new Error('note too large')
      const content = new TextDecoder('utf-8', { fatal: true }).decode(await file.arrayBuffer())
      return notesCreate(stem(file.name) || t('newNote'), '', content)
    }, 'noteImported', 'importTextError'),
    slides: picker('.pptx', file =>
      notesImportSlide(sessionId, stem(file.name) || t('newPresentation'), '', file), 'presentationImported', 'importSlideError'),
    mindmap: picker('.xmind,.codingmindmap', notesImportMindmap, 'mindmapImported', 'importMindmapError'),
    word: picker('.docx', file => notesImportOffice('word', file), 'wordImported', 'importWordError'),
    excel: picker('.xlsx', file => notesImportOffice('excel', file), 'excelImported', 'importExcelError'),
  }
}
