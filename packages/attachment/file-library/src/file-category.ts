import type { ManagedFileCategory, ManagedFileRecord } from './types.ts'

/** 根据记录媒体类型和安全文件名推导用户可理解的文件分类。 */
export function managedFileCategory(record: Pick<ManagedFileRecord, 'name' | 'mediaType'>): ManagedFileCategory {
  if (record.mediaType.startsWith('image/')) return 'image'
  if (record.mediaType.includes('presentation') || /\.(?:pptx?|key)$/iu.test(record.name)) return 'presentation'
  if (record.mediaType.includes('pdf') || record.mediaType.includes('word') || /\.(?:docx?|pdf|txt|md|csv)$/iu.test(record.name)) return 'document'
  return 'other'
}
