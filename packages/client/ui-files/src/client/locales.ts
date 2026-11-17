/** 文件管理分区文案键。 */
export const NS = 'settings.files'

export type FilesLocaleKey =
  | 'nav' | 'title' | 'intro' | 'name' | 'kind' | 'size' | 'date'
  | 'upload' | 'generatedImage' | 'export' | 'note' | 'loading' | 'empty' | 'error' | 'retry'
  | 'loadMore' | 'loadingMore' | 'count' | 'dateLocale' | 'pageTitle' | 'pageIntro' | 'back' | 'all' | 'space' | 'categories' | 'image' | 'presentation' | 'document' | 'other' | 'previewDialog' | 'close'

/** 简体中文文案。 */
export const zh: Record<FilesLocaleKey, string> = {
  nav: '文件管理', title: '文件管理', intro: '查看此设备保存的上传文件、生成图片和无目录笔记。', pageTitle: '全部', pageIntro: '输入文件、生成图片、导出成品和无目录笔记。', back: '返回对话', all: '全部', space: '资料空间', categories: '文件类型', image: '图片', presentation: '幻灯片', document: '文档', other: '其他', previewDialog: '图片预览', close: '关闭',
  name: '名称', kind: '类型', size: '大小', date: '创建时间',
  upload: '上传文件', generatedImage: '生成图片', export: '导出成品', note: '笔记',
  loading: '正在读取文件…', empty: '还没有保存的文件。',
  error: '无法读取文件列表。', retry: '重试', loadMore: '加载更多', loadingMore: '正在加载更多…',
  count: '个文件', dateLocale: 'zh-CN',
}

/** 英文文案。 */
export const en: Record<FilesLocaleKey, string> = {
  nav: 'Files', title: 'Files', intro: 'View uploads, generated images, and unscoped notes stored on this device.', pageTitle: 'All', pageIntro: 'Inputs, generated images, exports, and unscoped notes from chats without a workspace.', back: 'Back to conversation', all: 'All', space: 'Files', categories: 'File type', image: 'Images', presentation: 'Slides', document: 'Documents', other: 'Other', previewDialog: 'Image preview', close: 'Close',
  name: 'Name', kind: 'Type', size: 'Size', date: 'Created',
  upload: 'Upload', generatedImage: 'Generated image', export: 'Export', note: 'Note',
  loading: 'Loading files…', empty: 'No files have been saved yet.',
  error: 'Could not load the file list.', retry: 'Retry', loadMore: 'Load more', loadingMore: 'Loading more…',
  count: ' files', dateLocale: 'en-US',
}
