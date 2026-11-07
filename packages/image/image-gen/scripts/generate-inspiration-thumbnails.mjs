/**
 * 把两份固定版本灵感库的原始图片生成本地 WebP 缩略图，并维护客户端索引。
 *
 * 源仓库需先检出到固定提交；脚本只接受显式目录，避免构建时访问网络：
 *   pnpm --filter coding-image-gen gen:inspiration \
 *     --awesome /path/to/awesome-gpt-image-2 --handraw /path/to/handraw-style
 *
 * 缩略图最长边 320px，保持原构图，由卡片 CSS 负责方形裁切。文件名使用
 * 输出内容哈希，便于静态路由长期缓存；索引键沿用客户端已有的 sourceId + 原图路径。
 */
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const repositoryRoot = resolve(packageRoot, '../../..')
const clientRoot = join(repositoryRoot, 'packages/client/ui-image-gen/src/client/inspiration')
const outputRoot = join(packageRoot, 'assets/inspiration/v1')
const outputIndex = join(clientRoot, 'thumbnails.generated.json')
const sharp = createRequire(join(repositoryRoot, 'packages/attachment/attachment-local/package.json'))('sharp')

function argument(name) {
  const index = process.argv.indexOf(`--${name}`)
  const value = index < 0 ? undefined : process.argv[index + 1]
  if (value === undefined || value.startsWith('--')) throw new Error(`missing --${name}`)
  return resolve(value)
}

async function document(name) {
  return JSON.parse(await readFile(join(clientRoot, name), 'utf8'))
}

function imagePath(value) {
  if (typeof value !== 'string' || !/^\/images\/[A-Za-z0-9/_-]+\.(?:jpe?g|png|webp)$/u.test(value)) {
    throw new Error(`unsupported inspiration image path: ${String(value)}`)
  }
  return value
}

const sources = [
  {
    id: 'awesome-gpt-image-2',
    document: await document('awesome-gpt-image-2.json'),
    root: argument('awesome'),
  },
  {
    id: 'handraw-style',
    document: await document('handraw-style.json'),
    root: argument('handraw'),
  },
]

await mkdir(outputRoot, { recursive: true })
const entries = {}
let generated = 0
let reused = 0

for (const source of sources) {
  const cases = Array.isArray(source.document.cases) ? source.document.cases : []
  for (const entry of cases) {
    const relative = imagePath(entry.image)
    const sourcePath = join(source.root, relative.slice(1))
    const image = sharp(await readFile(sourcePath))
    const metadata = await image.metadata()
    if (metadata.width === undefined || metadata.height === undefined) {
      throw new Error(`inspiration image has no dimensions: ${sourcePath}`)
    }
    const { data, info } = await image
      .rotate()
      .resize({ width: 320, height: 320, fit: 'inside', withoutEnlargement: true })
      .webp({ quality: 76, alphaQuality: 80, effort: 4 })
      .toBuffer({ resolveWithObject: true })
    const digest = createHash('sha256').update(data).digest('hex').slice(0, 16)
    const file = `${digest}.webp`
    const target = join(outputRoot, file)
    try {
      await writeFile(target, data, { flag: 'wx' })
      generated++
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error
      const existing = await readFile(target)
      if (!existing.equals(data)) throw new Error(`content hash collision: ${file}`)
      reused++
    }
    entries[`${source.id}:${relative}`] = {
      file,
      width: info.width,
      height: info.height,
    }
  }
}

const ordered = Object.fromEntries(Object.entries(entries).sort(([left], [right]) => left.localeCompare(right)))
await writeFile(outputIndex, `${JSON.stringify(ordered, null, 2)}\n`)
console.log(`gen:inspiration: ${Object.keys(ordered).length} cases, ${generated} new files, ${reused} reused`)
