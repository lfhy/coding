/** 原画廊两份固定版本的灵感索引；元数据与压缩缩略图随应用一并交付。 */
import thumbnails from './inspiration/thumbnails.generated.json' with { type: 'json' }
import awesome from './inspiration/awesome-gpt-image-2.json' with { type: 'json' }
import handdraw from './inspiration/handraw-style.json' with { type: 'json' }
import { inspirationImageUrl } from './wire.ts'

export interface InspirationCase {
  id: string
  sourceId: string
  sourceLabel: string
  title: string
  category: string
  prompt: string
  preview: string
  imageUrl: string
  width: number
  height: number
  sourceUrl?: string
}

interface SourceDocument { cases?: unknown }

const SOURCES = [
  { id: 'awesome-gpt-image-2', label: 'GPT Image 2 案例库', document: awesome as SourceDocument },
  { id: 'handraw-style', label: '手绘风格手册', document: handdraw as SourceDocument },
] as const

interface Thumbnail {
  file: string
  width: number
  height: number
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined
}

function thumbnail(sourceId: string, image: string): Thumbnail {
  const entry = record((thumbnails as Record<string, unknown>)[`${sourceId}:${image}`])
  if (entry === undefined || typeof entry.file !== 'string' || !/^[a-f0-9]{16}\.webp$/u.test(entry.file)
    || typeof entry.width !== 'number' || !Number.isSafeInteger(entry.width) || entry.width < 1
    || typeof entry.height !== 'number' || !Number.isSafeInteger(entry.height) || entry.height < 1) {
    throw new Error(`missing inspiration thumbnail: ${sourceId}:${image}`)
  }
  return { file: entry.file, width: entry.width, height: entry.height }
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
      const preview = thumbnail(source.id, entry.image)
      return [{
        id: `${source.id}:${String(entry.id)}`,
        sourceId: source.id,
        sourceLabel: source.label,
        title: entry.title,
        category: typeof entry.category === 'string' ? entry.category : '',
        prompt: entry.prompt,
        preview: typeof entry.promptPreview === 'string' ? entry.promptPreview : entry.prompt.slice(0, 240),
        imageUrl: inspirationImageUrl(preview.file),
        width: preview.width,
        height: preview.height,
        ...(typeof entry.sourceUrl === 'string' && /^https:\/\//u.test(entry.sourceUrl)
          ? { sourceUrl: entry.sourceUrl } : {}),
      }]
    })
  })
}
