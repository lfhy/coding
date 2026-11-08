/**
 * 内置单页版式的只读预览：用实际新增页逻辑构造一份内存中的展示工程。
 * 这七页只供目录预览，不是可套用的整稿模板，也不写入用户模板库。
 * @module coding-ppt-workbench/builtin-templates
 */

import { parseDeck, PPT_FORMAT, type PptDeck } from 'coding-ppt-model'
import { buildTemplate, PPT_TEMPLATES } from './templates.ts'

const preview: PptDeck = {
  format: PPT_FORMAT,
  title: '内置版式预览',
  size: '16:9',
  theme: 'paper',
  pages: [],
}

/** 七种版式按目录顺序排列，页面 id 可供客户端稳定定位。 */
export const BUILTIN_TEMPLATE_PREVIEW: PptDeck = parseDeck({
  ...preview,
  pages: PPT_TEMPLATES.map(({ id, label }) => ({
    id,
    name: label,
    background: null,
    transition: 'none',
    elements: buildTemplate(id, preview, { title: label }),
  })),
})
