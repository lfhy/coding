/** 将源稿的可编辑几何与文字样式转为可复用模板，原文只用于识别字段角色。 */
import { parseDeck, type PptDeck, type PptElement, type PptPage } from 'coding-ppt-model'

const PAGE_TITLE = '页面标题'
const SHORT_LABEL = '要点标题'
const BODY = '填写简短说明'
const DATA = '填写数据'
const FOOTER = '演示文稿标题'

function genericText(content: string, element: Extract<PptElement, { kind: 'text' }>, index: number,
  maxSize: number, canvasHeight: number): string {
  const value = content.trim()
  if (value === '') return ''
  if (/^\d{1,3}\s*[/／]\s*\d{1,3}$/u.test(value) && element.y > canvasHeight * 0.84) return '页码'
  if (index === 0 && element.y < canvasHeight * 0.23 && value.length < 40) return '章节 / 页码'
  if (element.y < canvasHeight * 0.28 && element.text.size >= maxSize * 0.75) return PAGE_TITLE
  if (element.y > canvasHeight * 0.87) return FOOTER
  if (/^[-+]?\d+(?:[.,%]?[\d]*)?(?:\s*[a-zA-Z%倍]+)?$/u.test(value)) return DATA
  if (element.text.size >= maxSize * 0.7 || value.length < 13) return SHORT_LABEL
  return BODY
}

/**
 * 从已准入的源文稿提取几何、色彩和字级，不把源稿正文、页名、注释带入持久模板。
 * @param deck - 导入器生成的可编辑页面；调用方须先读报告并向用户呈现设计损失。
 * @param title - 新模板名称。
 * @returns 与源页顺序、坐标和图形匹配的可编辑模板，图像因不可脱敏而移除。
 */
export function extractTemplateDesign(deck: PptDeck, title: string): PptDeck {
  const pages: PptPage[] = deck.pages.map((page, pageIndex) => {
    const texts = page.elements.filter((item): item is Extract<PptElement, { kind: 'text' }> => item.kind === 'text')
    const maxSize = Math.max(6, ...texts.map(item => item.text.size))
    let textIndex = 0
    return {
      ...page, name: pageIndex === 0 ? '封面版式' : `版式 ${pageIndex + 1}`,
      elements: page.elements.flatMap((element): PptElement[] => {
        if (element.kind === 'image') return []
        if (element.kind === 'table') return [{ ...element, cells: element.cells.map((row, rowIndex) => (
          row.map((cell, columnIndex) => ({ content: cell.content.trim() === '' ? ''
            : rowIndex === 0 && element.header ? `字段 ${columnIndex + 1}` : DATA }))
        )) }]
        if (element.kind === 'chart') return [{ ...element,
          categories: element.categories.map((_, index) => `类别 ${index + 1}`),
          series: element.series.map((series, index) => ({ ...series, name: `系列 ${index + 1}`,
            values: series.values.map(() => 1) })),
        }]
        if (element.kind !== 'text') return [element]
        const content = genericText(element.text.content, element, textIndex++, maxSize, 720)
        // 空文本保留它原有的占位空间，不从原稿泄漏隐藏文字。
        return [{ ...element, text: { ...element.text, content } }]
      }),
    }
  })
  return parseDeck({ ...deck, title, pages })
}
