/** 解析有界 OOXML 部件与包内关系；转换器只读取通过预检的部件。 */
import type { OfficeKind } from '../types.ts'
import { auditOfficeXml } from './xml-policy.ts'
import {
  CONTENT_TYPES_NS, OFFICE_REL_NS, OFFICE_STRICT_REL_NS, PACKAGE_REL_NS,
  type XmlElement, readOfficeXml, xmlAttr, xmlChildren,
} from './xml.ts'
import { readOfficeZip, validOfficePartPath, validOfficePartSegment } from './zip.ts'

/** 普通 Office ZIP 的下载媒体类型；同一值用于检查对应 OOXML 主部件。 */
export const OFFICE_FORMAT = {
  word: { suffix: '.docx', mediaType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' },
  excel: { suffix: '.xlsx', mediaType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' },
} as const

const MANIFEST = '[content_types].xml'
const ROOT_RELS = '_rels/.rels'
const REL_MEDIA = 'application/vnd.openxmlformats-package.relationships+xml'
const MAX_META_BYTES = 2 * 1024 * 1024
const TOTAL_XML_ELEMENTS = 1_000_000
const BAD_PART_NAMES = new Set(['externallinks', 'vbadata.xml', 'activex', 'embeddings', 'macrosheets', 'webextensions',
  'connections.xml', 'querytables', 'customui'])
const BAD_TYPE = /macroenabled|macrosheet|vba|externallink|activex|oleobject|webextension|customui|connections|querytable/iu
const BAD_RELATIONS = new Set(['attachedtemplate', 'externaldata', 'externallink', 'externallinkpath', 'ddelink', 'oleobject',
  'control', 'package', 'afchunk', 'externalsublink', 'subdocument', 'webpublishobject', 'dataconnection', 'mailmergesource'])
const MEDIA_TYPE = /^[a-z\d!#$&^_.+-]+\/[a-z\d!#$&^_.+-]+$/iu

interface Relation { type: string; target: string }
type Relations = Map<string, Relation>

/** 只暴露内存部件和已验证的包内关系，不返回任意 URI。 */
export interface OfficePackage {
  readonly main: string
  xml(path: string): XmlElement
  related(owner: string, type: string): string | undefined
  relation(owner: string, id: string, type: string): string
}

function invalidPackage(): never { throw new TypeError('Office 包缺少必需的部件，或部件关系无效') }
function activePackage(): never { throw new TypeError('Office 文件不能含有外部关系、宏、外部连接或嵌入的活动对象') }

function decodeSegment(input: string): string {
  let segment: string
  try { segment = decodeURIComponent(input) }
  catch { invalidPackage() }
  if (!validOfficePartSegment(segment)) invalidPackage()
  return segment
}

function resolveTarget(owner: string, target: string, allowParent: boolean): string {
  if (target.length > 2048 || target === '' || target.startsWith('//')) invalidPackage()
  const absolute = target.startsWith('/')
  if (!absolute && !allowParent) invalidPackage()
  const segments = absolute || owner === '' ? [] : owner.split('/').slice(0, -1)
  for (const raw of (absolute ? target.slice(1) : target).split('/')) {
    if (raw === '..' && allowParent) {
      if (segments.pop() === undefined) invalidPackage()
    } else {
      segments.push(decodeSegment(raw))
    }
  }
  const path = segments.join('/')
  if (!validOfficePartPath(path)) invalidPackage()
  return path
}

function metaXml(bytes: Uint8Array | undefined, local: string, uri: string): XmlElement {
  if (bytes === undefined || bytes.byteLength > MAX_META_BYTES) invalidPackage()
  const root = readOfficeXml(bytes)
  if (root.local !== local || root.uri !== uri) invalidPackage()
  return root
}

function metaChildren(root: XmlElement): XmlElement[] {
  if (root.children.some(child => typeof child === 'string' && child.trim() !== '')) invalidPackage()
  const elements = xmlChildren(root)
  if (elements.some(node => node.uri !== root.uri || node.children.some(child => typeof child !== 'string' || child.trim() !== ''))) {
    invalidPackage()
  }
  return elements
}

function contentTypes(bytes: Uint8Array | undefined, paths: ReadonlyMap<string, string>): (path: string) => string {
  const defaults = new Map<string, string>()
  const overrides = new Map<string, string>()
  for (const child of metaChildren(metaXml(bytes, 'Types', CONTENT_TYPES_NS))) {
    const mime = xmlAttr(child, 'ContentType')?.toLowerCase()
    if (mime === undefined || mime.length > 255 || !MEDIA_TYPE.test(mime)) invalidPackage()
    if (BAD_TYPE.test(mime)) activePackage()
    if (child.local === 'Default') {
      const extension = xmlAttr(child, 'Extension')?.toLowerCase()
      if (extension === undefined || !/^[a-z\d][a-z\d._-]{0,31}$/u.test(extension) || defaults.has(extension)) invalidPackage()
      defaults.set(extension, mime)
    } else if (child.local === 'Override') {
      const target = resolveTarget('', xmlAttr(child, 'PartName') ?? '', false).toLowerCase()
      if (target === MANIFEST || !paths.has(target) || overrides.has(target)) invalidPackage()
      overrides.set(target, mime)
    } else invalidPackage()
  }
  return (path) => {
    const lower = path.toLowerCase()
    const ext = lower.slice(lower.lastIndexOf('/') + 1).split('.').at(-1)
    return overrides.get(lower) ?? defaults.get(ext ?? '') ?? invalidPackage()
  }
}

function relationshipOwner(path: string, paths: ReadonlyMap<string, string>): string {
  if (path.toLowerCase() === ROOT_RELS) return ''
  const segments = path.split('/')
  const name = segments.pop()?.slice(0, -'.rels'.length)
  if (name === undefined || name === '' || segments.pop()?.toLowerCase() !== '_rels') invalidPackage()
  return paths.get([...segments, name].join('/').toLowerCase()) ?? invalidPackage()
}

function readRelationships(
  bytes: Uint8Array, owner: string, paths: ReadonlyMap<string, string>,
): Relations {
  const relations: Relations = new Map()
  for (const child of metaChildren(metaXml(bytes, 'Relationships', PACKAGE_REL_NS))) {
    const id = xmlAttr(child, 'Id')
    const type = xmlAttr(child, 'Type')
    const mode = xmlAttr(child, 'TargetMode')
    const target = xmlAttr(child, 'Target')
    if (mode !== undefined && mode !== 'Internal' || BAD_TYPE.test(type ?? '')
      || BAD_RELATIONS.has(type?.toLowerCase().split('/').at(-1) ?? '')) activePackage()
    if (child.local !== 'Relationship' || id === undefined || id.length > 128 || !/^[_\p{L}][.\-\p{L}\p{N}_]*$/u.test(id)
      || type === undefined || type.length > 255 || !/^https?:\/\/[^\s]+$/u.test(type) || target === undefined || relations.has(id)) {
      invalidPackage()
    }
    const normalized = resolveTarget(owner, target, true).toLowerCase()
    const resolved = paths.get(normalized)
    if (normalized === MANIFEST || normalized.endsWith('.rels') || resolved === undefined) invalidPackage()
    relations.set(id, { type, target: resolved })
  }
  return relations
}

function officeRelation(relation: Relation, type: string): boolean {
  return relation.type === `${OFFICE_REL_NS}/${type}` || relation.type === `${OFFICE_STRICT_REL_NS}/${type}`
}

/**
 * 验证完整 ZIP 中的部件命名、类型、关系及活动内容，再允许转换器读取结构。
 * @param bytes - 用户提供的 Office 文件字节。
 * @param kind - 要求与主 XML 部件匹配的文件类型。
 * @returns 只读的内存包视图；发现不受信任的任何部件时整包拒绝。
 */
export function openOfficePackage(bytes: Uint8Array, kind: OfficeKind): OfficePackage {
  const entries = readOfficeZip(bytes)
  const paths = new Map([...entries.keys()].map(path => [path.toLowerCase(), path]))
  const manifest = paths.get(MANIFEST)
  if (manifest === undefined) invalidPackage()
  const mimeFor = contentTypes(entries.get(manifest), paths)
  const relationships = new Map<string, Relations>()
  const budget = { remaining: TOTAL_XML_ELEMENTS }
  for (const [path, contents] of entries) {
    if (path.toLowerCase().split('/').some(part => BAD_PART_NAMES.has(part) || /^vbaproject(?:signature.*)?\.bin$/u.test(part))) {
      activePackage()
    }
    if (path === manifest) continue
    const mime = mimeFor(path)
    const lower = path.toLowerCase()
    if (lower.endsWith('.rels') || mime === REL_MEDIA) {
      if (!lower.endsWith('.rels') || mime !== REL_MEDIA) invalidPackage()
      const owner = relationshipOwner(path, paths)
      if (relationships.has(owner)) invalidPackage()
      relationships.set(owner, readRelationships(contents, owner, paths))
    } else if (mime.endsWith('+xml') || mime.endsWith('/xml') || /\.(?:vml|svg|xml)$/u.test(lower)) {
      auditOfficeXml(contents, budget)
    }
  }
  function related(owner: string, type: string): string | undefined {
    const matches = [...(relationships.get(owner)?.values() ?? [])].filter(relation => officeRelation(relation, type))
    if (matches.length > 1) invalidPackage()
    return matches[0]?.target
  }
  const main = related('', 'officeDocument')
  if (main === undefined || mimeFor(main) !== `${OFFICE_FORMAT[kind].mediaType}.main+xml`) invalidPackage()
  return {
    main,
    related,
    xml(path) {
      const part = entries.get(path)
      if (part === undefined) invalidPackage()
      // 即使来源标错其他部件的内容类型，实际消费前仍然应用 XML 离线策略。
      const mime = mimeFor(path)
      if (!(mime.endsWith('+xml') || mime.endsWith('/xml') || /\.(?:vml|svg|xml)$/iu.test(path))) auditOfficeXml(part, budget)
      return readOfficeXml(part)
    },
    relation(owner, id, type) {
      const relation = relationships.get(owner)?.get(id)
      if (relation === undefined || !officeRelation(relation, type)) invalidPackage()
      return relation.target
    },
  }
}
