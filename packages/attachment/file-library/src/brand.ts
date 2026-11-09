/** 文件库记录标识的运行时入口。@module coding-file-library/brand */
import type { Branded } from 'coding-brand'

/** 文件库独有的跨包记录标识，序列化后仍为 UUID 字符串。 */
export type FileId = Branded<'FileId'>

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu

/**
 * 校验跨边界文件库 ID 并附加静态品牌。
 * @param value - 原始 UUID 字符串。
 * @returns 保持 JSON 字符串形式的文件库 ID。
 */
export function FileId(value: string): FileId {
  if (typeof value !== 'string' || !UUID.test(value)) throw new TypeError('文件标识必须为 UUID')
  return value as FileId
}
