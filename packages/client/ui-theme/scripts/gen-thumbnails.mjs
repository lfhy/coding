/**
 * 把 `src/themes/thumbnails/` 里的主题缩略图内联成 data URL 模块。
 *
 * 主题卡片要显示真实界面截图，而客户端插件的目录只对外提供 `client.js`——
 * 同目录下的图片文件不会被浏览器请求到。把图片内联进 bundle 是唯一不需要
 * 改动宿主静态资源约定的做法，代价是 bundle 变大，所以源图先压到 640px 宽
 * 的 JPEG（每张 25–50 KB）。
 *
 * 用法：`pnpm --filter coding-client-ui-theme gen:thumbnails`
 * 换图后重跑；生成物 `thumbnails.generated.ts` 不要手改。
 */
import { readdir, readFile, writeFile } from 'node:fs/promises'

const dir = new URL('../src/themes/thumbnails/', import.meta.url)
const out = new URL('../src/themes/thumbnails.generated.ts', import.meta.url)

const files = (await readdir(dir)).filter(name => name.endsWith('.jpg')).sort()
const entries = []
for (const file of files) {
  const bytes = await readFile(new URL(file, dir))
  const key = file.slice(0, -'.jpg'.length)
  const url = `data:image/jpeg;base64,${bytes.toString('base64')}`
  // 每 120 字符一段再用 `+` 连接：单行几十 KB 的字符串会被 lint 当成压缩文件，
  // 而且没人能在 diff 里看懂它。
  const chunks = url.match(/.{1,120}/g) ?? []
  entries.push(`  '${key}':\n    ${
    chunks.map(chunk => `'${chunk}'`).join(' +\n    ')
  },`)
}

const module = `/* 生成物：不要手改。换图后运行 pnpm --filter coding-client-ui-theme gen:thumbnails。 */

/** 主题缩略图：文件名（不含扩展名）→ data URL。 */
export const THEME_THUMBNAILS: Readonly<Record<string, string>> = {
${entries.join('\n')}
}
`
await writeFile(out, module)
console.log(`gen:thumbnails: wrote ${entries.length} thumbnails`)
