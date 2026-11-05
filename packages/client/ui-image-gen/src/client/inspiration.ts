/** 原画廊两份固定版本的灵感索引；仅引入元数据，图片按需从原来源的公开镜像读取。 */
import awesome from './inspiration/awesome-gpt-image-2.json' with { type: 'json' }
import handdraw from './inspiration/handraw-style.json' with { type: 'json' }

export interface InspirationCase {
  id: string
  sourceId: string
  sourceLabel: string
  title: string
  category: string
  prompt: string
  preview: string
  imageUrl: string
  sourceUrl?: string
}

interface SourceDocument { cases?: unknown }

const SOURCES = [
  { id: 'awesome-gpt-image-2', label: 'GPT Image 2 案例库',
    prefix: 'https://cdn.jsdelivr.net/gh/freestylefly/awesome-gpt-image-2@c7d293963b21c60bf338003915438cc5c39dd3ca/data',
    document: awesome as SourceDocument },
  { id: 'handraw-style', label: '手绘风格手册',
    prefix: 'https://cdn.jsdelivr.net/gh/yang0/handraw-style@50998b094866e22007001161bca12c892a3796b1',
    document: handdraw as SourceDocument },
] as const

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined
}

/**
 * 上游元数据只允许固定的图片相对路径；Prompt 和来源链接不参与下载地址拼接。
 * @returns 原版索引中可展示的两套案例。
 */
export function inspirationCases(): readonly InspirationCase[] {
  return SOURCES.flatMap((source) => {
    const raw = Array.isArray(source.document.cases) ? source.document.cases : []
    return raw.flatMap((value): InspirationCase[] => {
      const entry = record(value)
      if (entry === undefined || typeof entry.id !== 'string' && typeof entry.id !== 'number'
        || typeof entry.title !== 'string' || typeof entry.prompt !== 'string'
        || typeof entry.image !== 'string' || !/^\/images\/[A-Za-z0-9/_-]+\.(?:jpe?g|png|webp)$/u.test(entry.image)) return []
      return [{
        id: `${source.id}:${String(entry.id)}`,
        sourceId: source.id,
        sourceLabel: source.label,
        title: entry.title,
        category: typeof entry.category === 'string' ? entry.category : '',
        prompt: entry.prompt,
        preview: typeof entry.promptPreview === 'string' ? entry.promptPreview : entry.prompt.slice(0, 240),
        imageUrl: `${source.prefix}${entry.image}`,
        ...(typeof entry.sourceUrl === 'string' && /^https:\/\//u.test(entry.sourceUrl)
          ? { sourceUrl: entry.sourceUrl } : {}),
      }]
    })
  })
}
