/** 笔记协议与引擎快照之间的边界：Word 直接保存引擎快照，因此表格、图片、链接都能落盘。 */
import type { IDocumentData } from '@univerjs/presets'
import type { WordDocument, WordSnapshotData } from './office-document.ts'

// A4 纸在引擎里的像素尺寸（96dpi），与 Univer 的 PAGE_SIZE.A4 一致。
const A4 = { width: 794, height: 1124 }
// 页面四边留白：Word 默认的 1 英寸，正文不会贴到纸边。
const PAGE_MARGIN = 96
// DocumentFlavor.TRADITIONAL：按纸分页排版，白纸衬在桌面底色上。
const TRADITIONAL = 1

/**
 * 取出可以直接交给编辑器的快照；复制顶层对象，避免覆盖原快照里的文档标识。
 * 打开时把版式归一化为 A4 分页纸：快照里存的是内容与引擎结构，版式只在这一层决定，
 * 因此旧笔记（历史上按连续版式保存）不需要迁移就能拿到同样的纸张效果。
 * @param document - 已校验的 Word 笔记。
 * @param id - 当前编辑器实例的文档标识。
 * @param title - 编辑器使用的文档标题。
 * @returns 可交给 `createDocument` 的快照。
 */
export function toUniverDocument(document: WordDocument, id: string, title: string): IDocumentData {
  const snapshot = structuredClone(document.snapshot) as Record<string, unknown>
  const style = typeof snapshot.documentStyle === 'object' && snapshot.documentStyle !== null
    ? snapshot.documentStyle as Record<string, unknown>
    : {}
  const documentStyle = {
    ...style,
    documentFlavor: TRADITIONAL,
    pageSize: A4,
    marginTop: PAGE_MARGIN,
    marginBottom: PAGE_MARGIN,
    marginLeft: PAGE_MARGIN,
    marginRight: PAGE_MARGIN,
  }
  return { ...snapshot, id, ...(title === '' ? {} : { title }), documentStyle } as IDocumentData
}

/**
 * 读回编辑器当前内容。快照原样保存，不做字段裁剪：表格、图片和链接都由引擎在下次打开时还原。
 * @param snapshot - 引擎的完整文档快照。
 * @returns 可保存的 Word 笔记。
 */
export function fromUniverDocument(snapshot: IDocumentData): WordDocument {
  return { version: 2, kind: 'word', snapshot: structuredClone(snapshot) as unknown as WordSnapshotData }
}
