/** 办公编辑器通过客户端插件预设生成 Node 和浏览器入口。 */
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { clientBundle } from '../tsdown.client.ts'

const bundle = clientBundle('coding-client-ui-office', ['lib/types/index.js', 'lib/types/invariant.js'])
const resolve = createRequire(import.meta.url).resolve
const PREFIX = '\0office-preset-style:'
const SUFFIX = '.mjs'

// 公共预设仅解析相对样式。npm 预设的资源在包内解析为文本，再由画布生命周期挂载。
const presetStyles = {
  name: 'office-preset-style',
  resolveId(source: string) {
    if (!/^@univerjs\/preset-(docs|sheets)-core\/lib\/index\.css\?inline$/.test(source)) return null
    return PREFIX + resolve(source.slice(0, -'?inline'.length)) + SUFFIX
  },
  async load(this: { addWatchFile(path: string): void }, id: string) {
    if (!id.startsWith(PREFIX)) return null
    const path = id.slice(PREFIX.length, -SUFFIX.length)
    this.addWatchFile(path)
    const css = await readFile(path, 'utf8')
    return `export default ${JSON.stringify(css)}`
  },
}

export default (options: Parameters<typeof bundle>[0]) => bundle(options).map(config =>
  config.name === 'coding-client-ui-office/client'
    ? { ...config, minify: true, plugins: [presetStyles, config.plugins] }
    : config)
