/**
 * 从右键命中的元素定位可替换图片的目标。截图占位通常是矩形加一层同尺寸文字，
 * 只有紧邻且居中的图片提示文字才随矩形一起移除；普通正文不作为占位标签。
 * @module coding-client-ui-ppt-workbench/client/image-target
 */

import type { PptElement, PptPage } from 'coding-ppt-model'

/** 图片占位的可识别文案；用户自定义的普通矩形仍可单独替换。 */
const IMAGE_HINT = /截图|图片|照片|配图|插图|界面|图像/u

function isPlaceholderLabel(rect: PptElement, text: PptElement | undefined): text is Extract<PptElement, { kind: 'text' }> {
  return rect.kind === 'rect' && text?.kind === 'text'
    && IMAGE_HINT.test(text.text.content) && text.text.align === 'center' && text.text.valign === 'middle'
    && text.x === rect.x && text.y === rect.y && text.w === rect.w && text.h === rect.h
}

/**
 * 返回图片或矩形的替换目标；右键叠在矩形上的提示文字也会指向同一个矩形。
 * @param page - 当前页的有序元素。
 * @param id - 右键命中的元素。
 * @returns 目标 id 与可一并移除的提示文字 id；普通文本和其它形状返回 null。
 */
export function imageReplacementTarget(page: PptPage, id: string): { id: string; label?: string } | null {
  const index = page.elements.findIndex(element => element.id === id)
  const element = page.elements[index]
  if (element?.kind === 'image') return { id }
  if (element?.kind === 'rect') {
    const label = page.elements[index + 1]
    return isPlaceholderLabel(element, label) ? { id, label: label.id } : { id }
  }
  if (element?.kind === 'text') {
    const rect = page.elements[index - 1]
    if (rect !== undefined && isPlaceholderLabel(rect, element)) return { id: rect.id, label: id }
  }
  return null
}
