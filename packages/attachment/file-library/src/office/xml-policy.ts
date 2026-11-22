/** 即使不参与转换，Office 包中的活动 XML 部件也须通过同一离线策略。 */
import type { SaxesTagNS } from 'saxes'
import { OFFICE_MAX_FORMULA, validateOfficeFormula } from './formula.ts'
import { EXCEL_NS, EXCEL_STRICT_NS, visitOfficeXml, WORD_NS, WORD_STRICT_NS } from './xml.ts'

const CHART_NS = 'http://schemas.openxmlformats.org/drawingml/2006/chart'
const CHART_STRICT_NS = 'http://purl.oclc.org/ooxml/drawingml/chart'
const EXCEL_FORMULA_TAGS = new Set(['f', 'formula', 'formula1', 'formula2', 'definedName', 'calculatedColumnFormula', 'totalsRowFormula'])
const EXCEL_ACTIVE_TAGS = new Set(['externalReferences', 'externalReference', 'externalLink', 'externalBook', 'ddeLink',
  'oleLink', 'connections', 'queryTable', 'webPublishItems', 'webPublishObjects', 'webPr'])
const WORD_ACTIVE_TAGS = new Set(['mailMerge', 'attachedTemplate', 'object', 'control', 'altChunk', 'subDoc'])
const WORD_FIELDS = new Set(`AUTHOR COMMENTS CREATEDATE DATE DOCVARIABLE DOCPROPERTY EDITTIME FILENAME FORMCHECKBOX FORMDROPDOWN
FORMTEXT IF INDEX KEYWORDS LASTSAVEDBY LISTNUM NOTEREF NUMCHARS NUMPAGES NUMWORDS PAGE PAGEREF PRINTDATE QUOTE
REF REVNUM SAVEDATE SECTION SECTIONPAGES SEQ STYLEREF SUBJECT SYMBOL TC TIME TITLE TOC XE`.split(/\s+/u))
const SVG_NS = 'http://www.w3.org/2000/svg'
const XLINK_NS = 'http://www.w3.org/1999/xlink'

function activeContent(): never {
  throw new TypeError('Office 文件不能含有外部连接、宏、活动对象或联网字段')
}

function attr(tag: SaxesTagNS, local: string, uri = ''): string | undefined {
  return Object.values(tag.attributes).find(value => value.local === local && value.uri === uri)?.value
}

function wordField(text: string): void {
  const code = /^[a-z][a-z0-9]*(?=\s|$)/iu.exec(text.trim())?.[0]
  if (code === undefined || !WORD_FIELDS.has(code.toUpperCase())) activeContent()
}

function isFormula(tag: SaxesTagNS, excel: boolean): boolean {
  return excel && EXCEL_FORMULA_TAGS.has(tag.local)
    || (tag.uri === CHART_NS || tag.uri === CHART_STRICT_NS) && tag.local === 'f'
    || /^http:\/\/schemas\.microsoft\.com\/office\/excel\//u.test(tag.uri) && EXCEL_FORMULA_TAGS.has(tag.local)
}

/** 扫描所有 XML（含丢弃的部件）；不执行字段、不解析引用内容。 */
export function auditOfficeXml(bytes: Uint8Array, budget: { remaining: number }): void {
  let formula: { depth: number; source: string } | undefined
  const fields: Array<{ source: string; collecting: boolean }> = []
  let instructionDepth: number | undefined
  visitOfficeXml(bytes, {
    open(tag, depth) {
      const { local, uri } = tag
      const excel = uri === EXCEL_NS || uri === EXCEL_STRICT_NS
      const word = uri === WORD_NS || uri === WORD_STRICT_NS
      if (excel && EXCEL_ACTIVE_TAGS.has(local) || word && WORD_ACTIVE_TAGS.has(local)
        || Object.values(tag.attributes).some(attribute => attribute.uri === XLINK_NS && attribute.local === 'href'
          && !attribute.value.startsWith('#') || uri === SVG_NS && (attribute.local === 'href' || attribute.local === 'src')
          && !attribute.value.startsWith('#'))) activeContent()
      if (excel && local === 'hyperlink') {
        const location = attr(tag, 'location')
        if (location !== undefined && /[\[\]|/\\]|^[\w+.-]+:/u.test(location.trim())) activeContent()
      }
      if (excel && local === 'definedName' && /(?:^|\.)auto_(?:open|close|activate|deactivate)$/iu.test(attr(tag, 'name') ?? '')) {
        activeContent()
      }
      if (formula !== undefined || instructionDepth !== undefined) activeContent()
      if (isFormula(tag, excel)) formula = { depth, source: '' }
      if (!word) return
      if (local === 'fldSimple') wordField(attr(tag, 'instr', uri) ?? '')
      if (local === 'fldChar') {
        const boundary = attr(tag, 'fldCharType', uri)
        const current = fields.at(-1)
        if (boundary === 'begin') {
          if (fields.length >= 64) activeContent()
          fields.push({ source: '', collecting: true })
        } else if (boundary === 'separate' || boundary === 'end') {
          if (current === undefined) activeContent()
          if (current.collecting) wordField(current.source)
          current.collecting = false
          if (boundary === 'end') fields.pop()
        }
      }
      if (local === 'instrText' || local === 'delInstrText') {
        if (!fields.at(-1)?.collecting) activeContent()
        instructionDepth = depth
      }
    },
    text(value) {
      if (formula !== undefined) {
        if (formula.source.length + value.length > OFFICE_MAX_FORMULA) throw new TypeError('Excel 公式超过长度上限')
        formula.source += value
      }
      if (instructionDepth !== undefined) {
        const current = fields.at(-1)
        if (current === undefined || current.source.length + value.length > OFFICE_MAX_FORMULA) activeContent()
        current.source += value
      }
    },
    close(_tag, depth) {
      if (formula?.depth === depth) {
        const expression = formula.source.trim()
        // 共享、数组和模拟运算表可能只在锚点保存真实公式；空节点尚未产生可执行内容。
        if (expression !== '') validateOfficeFormula(expression.startsWith('=') ? expression : `=${expression}`)
        formula = undefined
      }
      if (instructionDepth === depth) instructionDepth = undefined
    },
  }, budget)
  if (fields.length !== 0) activeContent()
}
