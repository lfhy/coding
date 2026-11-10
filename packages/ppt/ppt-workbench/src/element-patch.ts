/**
 * 元素字段补丁：限制每类元素可修改的属性，并在合并后重新校验完整元素。
 * @module coding-ppt-workbench/element-patch
 */

import { parseElement, PptModelError, type PptElement } from 'coding-ppt-model'
import type { UpdateElementOp } from './ops.ts'

/** 只修改操作提供的字段；无效类型或表格维度由此处拒绝。 */
export function patchElement(element: PptElement, op: UpdateElementOp): PptElement {
  if (op.fill !== undefined && element.kind !== 'rect' && element.kind !== 'ellipse') {
    throw new PptModelError('fill 只对 rect / ellipse 元素有效')
  }
  if ((op.color !== undefined || op.width !== undefined) && element.kind !== 'line') {
    throw new PptModelError('color 与 width 只对 line 元素有效')
  }
  if (op.text !== undefined && element.kind !== 'text') {
    throw new PptModelError('text 只对 text 元素有效')
  }
  if ((op.source !== undefined || op.fit !== undefined) && element.kind !== 'image') {
    throw new PptModelError('source 与 fit 只对 image 元素有效')
  }
  if (op.cells !== undefined && element.kind !== 'table') {
    throw new PptModelError('cells 只对 table 元素有效')
  }
  if (op.chart !== undefined && element.kind !== 'chart') {
    throw new PptModelError('chart 只对 chart 元素有效')
  }
  const next: Record<string, unknown> = { ...element }
  if (op.frame !== undefined) {
    for (const key of ['x', 'y', 'w', 'h'] as const) {
      const value = op.frame[key]
      if (value !== undefined) next[key] = value
    }
  }
  if (element.kind === 'text' && op.text !== undefined) next.text = { ...element.text, ...op.text }
  if ((element.kind === 'rect' || element.kind === 'ellipse') && op.fill !== undefined) next.fill = op.fill
  if (element.kind === 'line') {
    if (op.color !== undefined) next.color = op.color
    if (op.width !== undefined) next.width = op.width
  }
  if (element.kind === 'image') {
    if (op.source !== undefined) next.source = op.source
    if (op.fit !== undefined) next.fit = op.fit
  }
  if (op.stacked !== undefined && element.kind !== 'chart') {
    throw new PptModelError('stacked 只对 chart 元素有效')
  }
  if (element.kind === 'chart' && op.stacked !== undefined) next.stacked = op.stacked
  if (element.kind === 'chart' && op.chart !== undefined) {
    if (op.chart.series.some(series => series.values.length !== op.chart?.categories.length)) {
      throw new PptModelError('图表系列的数值长度必须等于分类数')
    }
    next.categories = op.chart.categories
    next.series = op.chart.series
  }
  if (op.animation !== undefined) next.animation = op.animation
  if (op.emphasis !== undefined) next.emphasis = op.emphasis
  if (op.exitAnimation !== undefined) next.exitAnimation = op.exitAnimation
  if (op.pathAnimation !== undefined) next.pathAnimation = op.pathAnimation
  if (element.kind === 'table' && op.cells !== undefined) {
    if (op.cells.length !== element.rows || op.cells.some(row => row.length !== element.columns)) {
      throw new PptModelError(`cells 维度必须等于 ${element.rows} × ${element.columns}`)
    }
    next.cells = op.cells
  }
  return parseElement(next, 'element')
}
