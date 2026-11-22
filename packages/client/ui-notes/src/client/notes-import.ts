/** 文件选择器按类型隔离扩展名和读取方式，写入后的刷新与打开仍由笔记页负责。 */
import type { PropsLocale } from 'coding-client-ui-slots'
import type { NotesLocaleKey, NS } from './locales.ts'
import { notesCreate, notesImportMindmap, notesImportSlide } from './wire.ts'

const TEXT_MAX_BYTES = 1024 * 1024

/** 去掉最后一段扩展名；包含点号的文件名仍保留此前的部分。 */
function stem(name: string): string {
  return name.replace(/\.[^.]+$/u, '').trim()
}

type RunImport = (task: () => Promise<string>, done: NotesLocaleKey, failed: NotesLocaleKey) => Promise<void>

/**
 * 为每个导入入口提供选择器配置与一次性导入动作。
 * @param sessionId - 幻灯片宿主校验所需的笔记会话。
 * @param t - 笔记文案。
 * @param run - 页面持有的导入事务。
 * @param notify - 拒绝选中文件时的提示。
 * @returns 目录菜单的三个文件选择器。
 */
export function noteImportPickers(
  sessionId: string,
  t: PropsLocale<typeof NS>['t'],
  run: RunImport,
  notify: (key: NotesLocaleKey) => void,
) {
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
    textImport: picker('.md,.markdown,.txt', async (file) => {
      if (file.size > TEXT_MAX_BYTES) throw new Error('note too large')
      const content = new TextDecoder('utf-8', { fatal: true }).decode(await file.arrayBuffer())
      return notesCreate(stem(file.name) || t('newNote'), '', content)
    }, 'noteImported', 'importTextError'),
    slidesImport: picker('.pptx', file =>
      notesImportSlide(sessionId, stem(file.name) || t('newPresentation'), '', file), 'presentationImported', 'importSlideError'),
    mindmapImport: picker('.xmind,.codingmindmap', notesImportMindmap, 'mindmapImported', 'importMindmapError'),
  }
}
