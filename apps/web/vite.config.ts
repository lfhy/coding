import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
import type { Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import { clientBuildEnvironmentDefines } from '../../scripts/client-build-environment.ts'

const src = (rel: string): string => fileURLToPath(new URL(rel, import.meta.url))
const STANDALONE_ERROR = 'apps/web is not a standalone application: bare Vite cannot inject window.__DSH_BOOT__. '
  + 'From a repository checkout, run `pnpm dsh web`; an installed package uses `dsh web`. '
  + 'For client-plugin HMR, run `pnpm dsh web` together with `pnpm run dev:web`.'
const DEFAULT_CLIENT_TITLE = 'Coding'

/** 将构建时标题转义后写入 HTML，避免标题文本改变标记结构。 */
function escapeHtmlText(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/** 将公开构建标题写入初始 HTML 文档。 */
function clientDocumentTitle(): Plugin {
  const title = escapeHtmlText(process.env.DSH_CLIENT_TITLE ?? DEFAULT_CLIENT_TITLE)
  return {
    name: 'dsh-client-document-title',
    transformIndexHtml(html) {
      return html.replace('<title>Coding</title>', `<title>${title}</title>`)
    },
  }
}

/** 阻止 Vite 开发或预览服务暴露缺少启动清单的空壳。 */
function rejectStandaloneServe(): Plugin {
  return {
    name: 'dsh-reject-standalone-web-serve',
    config(_config, env) {
      if (env.command === 'serve') throw new Error(STANDALONE_ERROR)
    },
  }
}

/**
 * 按渲染依赖家族划分独立缓存块。这里只列 workspace 直接导入的 npm 包：
 * Rollup 会将仅供它们使用的传递依赖放进相应块，共享依赖仍由 Rollup 决定。
 * React、Cordis、workspace 代码和小型通用依赖留在 index；这些家族都不
 * 导入 React，以免手动分块把唯一的 React 实例拖离入口。
 *
 * 三个家族目前均为同步渲染所需，因此分块不会减少首次加载的总字节；
 * 它们独立变更时可复用其他家族的缓存，也能分别反映异常体积增长。
 */
const VENDOR_FAMILIES: ReadonlyMap<string, string> = new Map([
  ['katex', 'vendor-math'],
  ['shiki', 'vendor-highlight'],
  ['mdast-util-from-markdown', 'vendor-markdown'],
  ['mdast-util-gfm', 'vendor-markdown'],
  ['mdast-util-math', 'vendor-markdown'],
  ['micromark-core-commonmark', 'vendor-markdown'],
  ['micromark-extension-gfm', 'vendor-markdown'],
  ['micromark-extension-math', 'vendor-markdown'],
  ['micromark-factory-space', 'vendor-markdown'],
  ['micromark-util-character', 'vendor-markdown'],
  ['micromark-util-classify-character', 'vendor-markdown'],
  ['micromark-util-sanitize-uri', 'vendor-markdown'],
  ['micromark-util-symbol', 'vendor-markdown'],
  ['micromark-util-types', 'vendor-markdown'],
])

/**
 * ui-primitives 的 highlight.ts 静态导入这些启动语法；同包内的其他
 * read-card 语法仍需按需加载，不可归入启动高亮块。
 */
const BOOT_GRAMMAR_FILES: readonly string[] = [
  'dist/typescript.mjs',
  'dist/shellscript.mjs',
  'dist/json.mjs',
]

/** KaTeX 字体文件扩展名，统一输出到 assets/fonts/。 */
const FONT_EXTENSIONS: readonly string[] = ['.woff2', '.woff', '.ttf']

/**
 * 从解析后的模块 id 提取 npm 包名；pnpm 的真实包位于内层 node_modules。
 */
function npmPackageOf(id: string): string | undefined {
  const parts = id.split('/node_modules/')
  if (parts.length === 1) return undefined
  const [first, second] = parts[parts.length - 1].split('/')
  if (first.startsWith('.')) return undefined // .pnpm 存储目录，不是包名
  if (first.startsWith('@')) return second === undefined ? undefined : `${first}/${second}`
  return first
}

export default defineConfig({
  plugins: [rejectStandaloneServe(), clientDocumentTitle(), react()],
  build: {
    sourcemap: true,
    // C++ 语法按需加载，Shiki 的 cpp + cpp-macro 当前为 638 kB
    // （gzip 约 47 kB）；保留完整语法并单独监测超过 650 kB 的块。
    chunkSizeWarningLimit: 650,
    rollupOptions: {
      output: {
        // 启动块放在 assets/ 根目录，按需语法放在 assets/langs/；
        // KaTeX 字体集中放在 assets/fonts/。sourcemap 跟随对应 JS。
        chunkFileNames(chunk): string {
          // 共享嵌入语法可能没有 facade，按成员模块识别语法块。
          // 启动高亮块包含三个启动语法，但仍放在 assets/ 根目录。
          if (chunk.name === 'index' || chunk.name.startsWith('vendor-')) return 'assets/[name]-[hash].js'
          const isLangChunk = chunk.moduleIds.some(id => id.includes('/node_modules/@shikijs/langs/'))
          return isLangChunk ? 'assets/langs/[name]-[hash].js' : 'assets/[name]-[hash].js'
        },
        assetFileNames(asset): string {
          const fileName = asset.names[0] ?? ''
          const isFont = FONT_EXTENSIONS.some(ext => fileName.endsWith(ext))
          return isFont ? 'assets/fonts/[name]-[hash][extname]' : 'assets/[name]-[hash][extname]'
        },
        manualChunks(id: string): string | undefined {
          const pkg = npmPackageOf(id)
          if (pkg === undefined) return undefined // workspace 与 vendored Cordis 留在 index
          if (pkg === '@shikijs/langs') {
            return BOOT_GRAMMAR_FILES.some(file => id.endsWith(`/${file}`)) ? 'vendor-highlight' : undefined
          }
          return VENDOR_FAMILIES.get(pkg)
        },
      },
    },
  },
  resolve: {
    // One instance per shared npm identity: a bare specifier otherwise resolves
    // from the importer's directory, so a diverging range ships a second React
    // and splits hook and element identity. Entries are package ids — they cover
    // react/jsx-runtime and react-dom/client — and resolve from this package's
    // node_modules, so react must stay a devDependency here and any watcher must
    // run vite from this directory (scripts/dev-web.ts). Workspace packages need
    // no entry: pnpm links each of them to a single directory.
    dedupe: ['react', 'react-dom'],
    // Workspace packages are consumed as built lib products: each resolves
    // through its own package.json exports from the importer's directory, and
    // CSS still rides Vite's pipeline because the client build preset emits it
    // beside the bundle. Plugin packages never enter this graph; they arrive as
    // runtime bundles through the client module system. The remaining alias
    // browserizes the vendored Cordis Loader's only Node import.
    alias: [
      { find: /^node:module$/, replacement: src('./src/node-module-stub.ts') },
    ],
  },
  define: {
    ...clientBuildEnvironmentDefines(process.env),
    // vendored loader internal.ts: fromInternal() probes the Node major —
    // "0.0.0" takes neither branch, returning undefined (exactly the empty
    // internal slot the shell boot fills with the client module loader).
    'process.versions.node': '"0.0.0"',
    'process.execArgv': '[]',
    // vendored loader index.ts: envData falls to its default branch.
    'process.env.CORDIS_SHARED': 'undefined',
  },
})
