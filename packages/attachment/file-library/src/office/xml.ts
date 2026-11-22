/** Office XML 仅作结构化数据解析：不解析 DTD、不加载实体或任意外部资源。 */
import { SaxesParser, type SaxesTagNS } from 'saxes'

export const WORD_NS = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'
export const WORD_STRICT_NS = 'http://purl.oclc.org/ooxml/wordprocessingml/main'
export const EXCEL_NS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'
export const EXCEL_STRICT_NS = 'http://purl.oclc.org/ooxml/spreadsheetml/main'
export const OFFICE_REL_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
export const OFFICE_STRICT_REL_NS = 'http://purl.oclc.org/ooxml/officeDocument/relationships'
export const PACKAGE_REL_NS = 'http://schemas.openxmlformats.org/package/2006/relationships'
export const CONTENT_TYPES_NS = 'http://schemas.openxmlformats.org/package/2006/content-types'

const MAX_DEPTH = 64
const MAX_ELEMENTS = 500_000
const MAX_ATTRIBUTES = 64
const MAX_ATTRIBUTE_LENGTH = 32_768
const XML_NS = 'http://www.w3.org/XML/1998/namespace'
const XMLNS_NS = 'http://www.w3.org/2000/xmlns/'
const XINCLUDE_NS = 'http://www.w3.org/2001/XInclude'
const XSI_NS = 'http://www.w3.org/2001/XMLSchema-instance'

/** 高层解析器只依赖解析后的命名空间、局部名称与属性值，不信任前缀。 */
export interface XmlAttribute { local: string; uri: string; value: string }

/** 一个已校验命名空间的 XML 元素；子元素与文字维持原顺序。 */
export interface XmlElement {
  local: string
  uri: string
  attributes: readonly XmlAttribute[]
  children: readonly (XmlElement | string)[]
}

type MutableElement = Omit<XmlElement, 'children'> & { children: (XmlElement | string)[] }

interface XmlVisitor {
  open?: (tag: SaxesTagNS, depth: number) => void
  text?: (value: string) => void
  close?: (tag: SaxesTagNS, depth: number) => void
}

function invalidXml(): never { throw new TypeError('Office XML 格式无效') }

function externalXml(): never { throw new TypeError('Office 文件不能含有外部 XML、DTD 或处理指令') }

function xmlSource(bytes: Uint8Array): { source: string; encoding: string } {
  const encoding = bytes[0] === 0xff && bytes[1] === 0xfe ? 'utf-16le'
    : bytes[0] === 0xfe && bytes[1] === 0xff ? 'utf-16be' : 'utf-8'
  try { return { source: new TextDecoder(encoding, { fatal: true }).decode(bytes), encoding } }
  catch { return invalidXml() }
}

/**
 * 流式访问有界 XML；不保留未使用部件的节点，源解析错误不向消费者回显。
 * @param bytes - ZIP 已限制字节数的单个 XML 部件。
 * @param visitor - 带命名空间的元素与正文事件。
 * @param budget - 可选的整包元素额度，与单部件额度分别核对。
 */
export function visitOfficeXml(bytes: Uint8Array, visitor: XmlVisitor, budget?: { remaining: number }): void {
  const { source, encoding } = xmlSource(bytes)
  const parser = new SaxesParser({ xmlns: true })
  let depth = 0
  let elements = 0
  let attributes = 0
  parser.on('xmldecl', (decl) => {
    if (decl.version !== '1.0') invalidXml()
    const declared = decl.encoding?.toLowerCase()
    if (declared !== undefined && declared !== encoding && !(declared === 'utf-16' && encoding !== 'utf-8')) invalidXml()
  })
  parser.on('error', invalidXml)
  parser.on('doctype', externalXml)
  parser.on('processinginstruction', externalXml)
  parser.on('opentagstart', () => { attributes = 0 })
  parser.on('attribute', (attribute) => {
    attributes += 1
    if (attributes > MAX_ATTRIBUTES || attribute.value.length > MAX_ATTRIBUTE_LENGTH) invalidXml()
  })
  parser.on('opentag', (tag) => {
    depth += 1
    elements += 1
    if (budget !== undefined) budget.remaining -= 1
    if (depth > MAX_DEPTH || elements > MAX_ELEMENTS || budget !== undefined && budget.remaining < 0) {
      throw new TypeError('Office XML 的元素数量或层级超出上限')
    }
    if (tag.uri === XINCLUDE_NS || Object.values(tag.attributes).some(attr =>
      attr.uri === XML_NS && attr.local === 'base'
      || attr.uri === XSI_NS && (attr.local === 'schemaLocation' || attr.local === 'noNamespaceSchemaLocation'))) externalXml()
    visitor.open?.(tag, depth)
  })
  parser.on('closetag', (tag) => { visitor.close?.(tag, depth); depth -= 1 })
  parser.on('text', value => visitor.text?.(value))
  parser.on('cdata', value => visitor.text?.(value))
  parser.write(source).close()
}

/** 构造单个实际消费的部件的有限 XML 树。 */
export function readOfficeXml(bytes: Uint8Array): XmlElement {
  const stack: MutableElement[] = []
  let root: XmlElement | undefined
  visitOfficeXml(bytes, {
    open(tag) {
      const current: MutableElement = { local: tag.local, uri: tag.uri, children: [],
        attributes: Object.values(tag.attributes).filter(attribute => attribute.uri !== XMLNS_NS) }
      const parent = stack.at(-1)
      if (parent === undefined) root = current
      else parent.children.push(current)
      stack.push(current)
    },
    text(value) { stack.at(-1)?.children.push(value) },
    close() { stack.pop() },
  })
  return root ?? invalidXml()
}

/** 获取符合名称和可选命名空间的首个直接子元素。 */
export function xmlChild(element: XmlElement | undefined, local: string, uri?: string): XmlElement | undefined {
  return element?.children.find((child): child is XmlElement => typeof child !== 'string'
    && child.local === local && (uri === undefined || child.uri === uri))
}

/** 获取符合可选名称和命名空间的直接子元素。 */
export function xmlChildren(element: XmlElement | undefined, local?: string, uri?: string): XmlElement[] {
  return element?.children.filter((child): child is XmlElement => typeof child !== 'string'
    && (local === undefined || child.local === local) && (uri === undefined || child.uri === uri)) ?? []
}

/** 属性按展开名查找；未指定命名空间时只匹配无命名空间的属性。 */
export function xmlAttr(element: Pick<XmlElement, 'attributes'> | undefined, local: string, uri = ''): string | undefined {
  return element?.attributes.find(attribute => attribute.local === local && attribute.uri === uri)?.value
}

/** 合并所有后代文字；元素始终来自已限制深度的 XML 树。 */
export function xmlText(element: XmlElement | undefined): string {
  if (element === undefined) return ''
  const parts: string[] = []
  function gather(node: XmlElement): void {
    for (const child of node.children) {
      if (typeof child === 'string') parts.push(child)
      else gather(child)
    }
  }
  gather(element)
  return parts.join('')
}

const ESCAPES: Record<string, string> = {
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;', '\t': '&#9;', '\n': '&#10;', '\r': '&#13;',
}

/** 用于生成 XML 的已校验字符串；避免 XML 换行或属性空白归一化改变数据。 */
export function escapeXml(value: string): string {
  return value.replace(/[&<>"'\t\n\r]/gu, char => ESCAPES[char] ?? char)
}
