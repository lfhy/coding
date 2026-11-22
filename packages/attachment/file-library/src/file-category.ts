import type { ManagedFileCategory, ManagedFileRecord } from './types.ts'

const UPLOAD_MEDIA: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
  pdf: 'application/pdf', txt: 'text/plain', md: 'text/markdown', csv: 'text/csv',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
}

/** 按扩展名标注上传类型，不验证文件内容。
 * @param name - 已经净化的上传名称。
 * @returns 已知媒体类型，或通用二进制类型。
 */
export function managedUploadMediaType(name: string): string {
  const extension = name.split('.').at(-1)?.toLowerCase() ?? ''
  return (Object.hasOwn(UPLOAD_MEDIA, extension) ? UPLOAD_MEDIA[extension] : undefined) ?? 'application/octet-stream'
}

/** 根据记录媒体类型和安全文件名推导用户可理解的文件分类。 */
export function managedFileCategory(record: Pick<ManagedFileRecord, 'name' | 'mediaType'>): ManagedFileCategory {
  if (record.mediaType.startsWith('image/')) return 'image'
  if (record.mediaType.includes('presentation') || /\.(?:pptx?|key)$/iu.test(record.name)) return 'presentation'
  if (record.mediaType.includes('pdf') || record.mediaType.includes('word') || record.mediaType.includes('spreadsheetml')
    || /\.(?:docx?|xlsx|pdf|txt|md|csv)$/iu.test(record.name)) return 'document'
  return 'other'
}
