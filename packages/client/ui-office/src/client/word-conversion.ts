/** 笔记协议与引擎快照之间的边界：Word 直接保存引擎快照，因此表格、图片、链接都能落盘。 */
import type { IDocumentData } from '@univerjs/presets'
import type { WordDocument, WordSnapshotData } from './office-document.ts'

/**
 * 取出可以直接交给编辑器的快照；复制顶层对象，避免覆盖原快照里的文档标识。
 * @param document - 已校验的 Word 笔记。
 * @param id - 当前编辑器实例的文档标识。
 * @param title - 编辑器使用的文档标题。
 * @returns 可交给 `createDocument` 的快照。
 */
export function toUniverDocument(document: WordDocument, id: string, title: string): IDocumentData {
  const snapshot = structuredClone(document.snapshot) as Record<string, unknown>
  return { ...snapshot, id, ...(title === '' ? {} : { title }) } as IDocumentData
}

/**
 * 读回编辑器当前内容。快照原样保存，不做字段裁剪：表格、图片和链接都由引擎在下次打开时还原。
 * @param snapshot - 引擎的完整文档快照。
 * @returns 可保存的 Word 笔记。
 */
export function fromUniverDocument(snapshot: IDocumentData): WordDocument {
  return { version: 2, kind: 'word', snapshot: structuredClone(snapshot) as unknown as WordSnapshotData }
}
