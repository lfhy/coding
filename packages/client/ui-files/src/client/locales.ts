/** 文件管理分区文案键。 */
export type FilesLocaleKey =
  | 'nav' | 'title' | 'intro' | 'name' | 'kind' | 'size' | 'date'
  | 'upload' | 'generatedImage' | 'loading' | 'empty' | 'error' | 'retry'
  | 'loadMore' | 'loadingMore' | 'count' | 'dateLocale'

/** 简体中文文案。 */
export const zh: Record<FilesLocaleKey, string> = {
  nav: '文件管理', title: '文件管理', intro: '查看此设备保存的上传文件和生成图片。',
  name: '名称', kind: '类型', size: '大小', date: '创建时间',
  upload: '上传文件', generatedImage: '生成图片',
  loading: '正在读取文件…', empty: '还没有保存的文件。',
  error: '无法读取文件列表。', retry: '重试', loadMore: '加载更多', loadingMore: '正在加载更多…',
  count: '个文件', dateLocale: 'zh-CN',
}

/** 英文文案。 */
export const en: Record<FilesLocaleKey, string> = {
  nav: 'Files', title: 'Files', intro: 'View uploads and generated images stored on this device.',
  name: 'Name', kind: 'Type', size: 'Size', date: 'Created',
  upload: 'Upload', generatedImage: 'Generated image',
  loading: 'Loading files…', empty: 'No files have been saved yet.',
  error: 'Could not load the file list.', retry: 'Retry', loadMore: 'Load more', loadingMore: 'Loading more…',
  count: ' files', dateLocale: 'en-US',
}
