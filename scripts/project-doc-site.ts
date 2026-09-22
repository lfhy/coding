/**
 * 把仓库定稿 Markdown 投影为 VitePress 源树的构建期适配器。
 *
 * 生成树是即弃的：内容留在所属 `docs/` 层级，本适配器只为公开站点
 * 改写跨源链接。站点单语言中文，`foo.md` 即中文定稿。
 */

import {
  copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync,
} from 'node:fs'
import { basename, dirname, extname, posix, relative, resolve, sep } from 'node:path'
import { fromMarkdown } from 'mdast-util-from-markdown'
import { gfmFromMarkdown } from 'mdast-util-gfm'
import { gfm } from 'micromark-extension-gfm'
import type { Nodes } from 'mdast'
import { docsPages, type DocsLocale, type DocsPage } from '../website/docs.ts'

const REPOSITORY_URL = 'https://github.com/deepseek-ai/deepseek-harness'
const root = resolve(import.meta.dirname, '..')
const generatedRoot = resolve(root, 'website/.generated')

/**
 * Resolve the public repository ref used by projected source links.
 *
 * @param environment Build environment containing an optional explicit public ref.
 * @returns The configured public ref, or `master`.
 */
export function resolveRepositoryRef(environment: NodeJS.ProcessEnv): string {
  return environment.DOCS_REPOSITORY_REF ?? 'master'
}

interface Replacement {
  start: number
  end: number
  value: string
}

interface DestinationRange {
  start: number
  end: number
}

type RewritableNode = Extract<Nodes, { type: 'link' | 'image' | 'definition' }>

/** Inputs for rewriting one canonical Markdown page. */
export interface RewriteMarkdownOptions {
  locale: DocsLocale
  sourcePath: string
  route: string
  pages: DocsPage[]
  repoRoot: string
  repositoryRef: string
  /**
   * Place one referenced image beside the projected page and return the URL to
   * reach it from that page. A GitHub raw URL cannot serve this repository —
   * `raw.githubusercontent.com` answers 404 for a private one, and no reader of
   * the site is authenticated to it — so an image travels into the generated
   * tree and Vite bundles it like any other site asset. Omitted by callers that
   * only rewrite text, which then leave images pointing at the repository.
   */
  placeImage?: (absPath: string) => string
}

function repoPath(absPath: string, repoRoot: string): string {
  return relative(repoRoot, absPath).split(sep).join('/')
}

function isExternalOrSiteAbsolute(url: string): boolean {
  return url.startsWith('#')
    || url.startsWith('//')
    || url.startsWith('/')
    || /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(url)
}

function skipWhitespace(source: string, start: number): number {
  let index = start
  while (/\s/.test(source[index] ?? '')) index += 1
  return index
}

function labelEnd(source: string): number {
  const first = source.indexOf('[')
  if (first === -1) return -1
  let depth = 0
  for (let index = first; index < source.length; index += 1) {
    const char = source[index]
    if (char === '\\') {
      index += 1
    } else if (char === '[') {
      depth += 1
    } else if (char === ']') {
      depth -= 1
      if (depth === 0) return index
    }
  }
  return -1
}

function destinationRange(rawNode: string, type: 'link' | 'image' | 'definition'): DestinationRange {
  const endOfLabel = labelEnd(rawNode)
  if (endOfLabel === -1) {
    throw new Error(`project-doc-site: cannot locate label end in ${JSON.stringify(rawNode)}.`)
  }

  let start: number
  if (type === 'definition') {
    const colon = rawNode.indexOf(':', endOfLabel + 1)
    if (colon === -1) {
      throw new Error(`project-doc-site: cannot locate definition separator in ${JSON.stringify(rawNode)}.`)
    }
    start = skipWhitespace(rawNode, colon + 1)
  } else {
    if (rawNode[endOfLabel + 1] !== '(') {
      throw new Error(`project-doc-site: cannot locate inline destination in ${JSON.stringify(rawNode)}.`)
    }
    start = skipWhitespace(rawNode, endOfLabel + 2)
  }

  if (rawNode[start] === '<') {
    for (let index = start + 1; index < rawNode.length; index += 1) {
      if (rawNode[index] === '\\') index += 1
      else if (rawNode[index] === '>') return { start: start + 1, end: index }
    }
    throw new Error(`project-doc-site: cannot locate angle-bracket destination end in ${JSON.stringify(rawNode)}.`)
  }

  let depth = 0
  for (let index = start; index < rawNode.length; index += 1) {
    const char = rawNode[index]
    if (char === '\\') {
      index += 1
    } else if (char === '(') {
      depth += 1
    } else if (char === ')') {
      if (depth === 0) return { start, end: index }
      depth -= 1
    } else if (/\s/.test(char ?? '') && depth === 0) {
      return { start, end: index }
    }
  }
  return { start, end: rawNode.length }
}

// `#fragment` suffixes pass through verbatim. Generated cordis-surface
// headings carry explicit `<a id>` anchors with the GitHub slug, so those
// fragments resolve on the published site too; hand-written headings rely on
// VitePress's own slugger, which differs from GitHub's for punctuation-heavy
// text — hand-authored cross-page fragments should prefer plain-text headings
// or explicit anchors.
function splitTarget(url: string): { path: string; suffix: string } {
  const boundary = url.search(/[?#]/)
  if (boundary === -1) return { path: url, suffix: '' }
  return { path: url.slice(0, boundary), suffix: url.slice(boundary) }
}

function decodePath(path: string): string {
  try {
    return decodeURIComponent(path)
  } catch {
    throw new Error(`project-doc-site: malformed percent escape in ${JSON.stringify(path)}.`)
  }
}

function routeTarget(fromRoute: string, toRoute: string, suffix: string): string {
  const target = posix.relative(posix.dirname(fromRoute), toRoute)
  return `${target.startsWith('.') ? target : `./${target}`}${suffix}`
}

function sourceMap(pages: DocsPage[]): Map<string, DocsPage> {
  const map = new Map<string, DocsPage>()
  for (const page of pages) {
    for (const source of [page.source, ...(page.sourceAliases ?? [])]) {
      const holder = map.get(source)
      if (holder !== undefined && holder !== page) {
        throw new Error(`project-doc-site: duplicate source or alias ${JSON.stringify(source)}.`)
      }
      map.set(source, page)
    }
  }
  return map
}

function resolveRepositoryTarget(sourceAbs: string, rawPath: string, repoRoot: string): { absPath: string; line?: number } {
  const decoded = decodePath(rawPath)
  let absPath = resolve(dirname(sourceAbs), decoded)
  if (existsSync(absPath)) return { absPath }

  const lineMatch = decoded.match(/:(\d+)$/)
  if (lineMatch !== null) {
    const lineText = lineMatch[1]
    if (lineText === undefined) throw new Error('project-doc-site: line suffix matched without a line number.')
    absPath = resolve(dirname(sourceAbs), decoded.slice(0, -lineMatch[0].length))
    if (existsSync(absPath)) return { absPath, line: Number.parseInt(lineText, 10) }
  }

  if (extname(decoded) === '') {
    const markdown = resolve(dirname(sourceAbs), `${decoded}.md`)
    if (existsSync(markdown)) return { absPath: markdown }
    const index = resolve(dirname(sourceAbs), decoded, 'index.md')
    if (existsSync(index)) return { absPath: index }
  }

  throw new Error(`project-doc-site: ${repoPath(sourceAbs, repoRoot)} links to missing path ${JSON.stringify(rawPath)}.`)
}

function githubTarget(
  absPath: string,
  line: number | undefined,
  suffix: string,
  repositoryRef: string,
  repoRoot: string,
  image: boolean,
): string {
  const path = repoPath(absPath, repoRoot)
  if (image) return `https://raw.githubusercontent.com/deepseek-ai/deepseek-harness/${repositoryRef}/${path}${suffix}`
  const kind = lstatSync(absPath).isDirectory() ? 'tree' : 'blob'
  const lineSuffix = line === undefined ? suffix : `#L${line}`
  return `${REPOSITORY_URL}/${kind}/${repositoryRef}/${path}${lineSuffix}`
}

/**
 * Rewrite repository-relative links without reserializing Markdown.
 *
 * @param source Markdown text from the canonical file.
 * @param options Source, route, manifest, and repository context.
 * @returns Markdown whose published links resolve inside the site or to GitHub.
 */
export function rewriteMarkdown(source: string, options: RewriteMarkdownOptions): string {
  const sourceAbs = resolve(options.repoRoot, options.sourcePath)
  const published = sourceMap(options.pages)
  const tree = fromMarkdown(source, { extensions: [gfm()], mdastExtensions: [gfmFromMarkdown()] })
  const replacements: Replacement[] = []

  const rewrite = (node: RewritableNode): void => {
    if (isExternalOrSiteAbsolute(node.url)) return
    const { path, suffix } = splitTarget(node.url)
    if (path === '') return
    const { absPath, line } = resolveRepositoryTarget(sourceAbs, path, options.repoRoot)
    const targetPath = repoPath(absPath, options.repoRoot)
    const page = published.get(targetPath)
    const nextUrl = page !== undefined
      ? routeTarget(options.route, page.route, suffix)
      : node.type === 'image' && options.placeImage !== undefined
        // The suffix rides along exactly as the GitHub branch keeps it: an SVG
        // view fragment or a Vite query changes what the reference means.
        ? `${options.placeImage(absPath)}${suffix}`
        : githubTarget(absPath, line, suffix, options.repositoryRef, options.repoRoot, node.type === 'image')

    const start = node.position?.start.offset
    const end = node.position?.end.offset
    if (start === undefined || end === undefined) {
      throw new Error(`project-doc-site: link ${JSON.stringify(node.url)} has no source offsets.`)
    }
    const rawNode = source.slice(start, end)
    const rawDestination = destinationRange(rawNode, node.type)
    replacements.push({
      start: start + rawDestination.start,
      end: start + rawDestination.end,
      value: nextUrl,
    })
  }

  const visit = (node: Nodes): void => {
    if ((node.type === 'link' || node.type === 'image' || node.type === 'definition') && 'url' in node) rewrite(node)
    if ('children' in node) {
      for (const child of node.children) visit(child)
    }
  }
  visit(tree)

  let projected = source
  for (const replacement of replacements.sort((a, b) => b.start - a.start)) {
    projected = projected.slice(0, replacement.start) + replacement.value + projected.slice(replacement.end)
  }
  return projected
}

/**
 * Record the canonical edit target in VitePress frontmatter.
 *
 * @param markdown Projected Markdown content.
 * @param page Publication manifest entry for the content.
 * @returns Markdown with projection-owned frontmatter fields.
 */
export function addProjectionFrontmatter(markdown: string, page: Pick<DocsPage, 'source' | 'outline'>): string {
  const fields = [
    `editSource: ${JSON.stringify(page.source)}`,
    ...(page.outline === undefined ? [] : [`outline: ${JSON.stringify(page.outline)}`]),
  ].join('\n')
  if (markdown.startsWith('---\n')) return markdown.replace('---\n', `---\n${fields}\n`)
  return `---\n${fields}\n---\n\n${markdown}`
}

/** 定稿页为 GitHub 读者携带的双语切换行；单语言站点不再投影它。 */
const LANGUAGE_SWITCHER = /^(?:English \| \[中文\]\([^)]*\)|\[English\]\([^)]*\) \| 中文)$/

/** 定稿页为 GitHub 读者携带的仓库徽章。 */
const REPOSITORY_BADGE = /^\[!\[[^\]]*\]\(https:\/\/img\.shields\.io\/[^)]*\)\]\([^)]*\)$/

/**
 * 删除面向定稿页 GitHub 读者的行。
 *
 * 站点是单语言中文，没有语言切换入口；切换行指向已不存在的对侧文件，
 * 仓库徽章则与每页页脚的仓库链接重复。
 *
 * @param markdown 已改写链接的定稿 Markdown 内容。
 * @returns 不含切换行与仓库徽章的内容。
 */
function withoutRepositoryChrome(markdown: string): string {
  const lines = markdown.split('\n')
  const switcher = lines.findIndex(line => LANGUAGE_SWITCHER.test(line))
  // 只有引入页面的切换行才算数；再往下的同一文本是正文或示例，不是页面自身的头部。
  if (switcher !== -1) {
    lines.splice(switcher, lines[switcher + 1] === '' ? 2 : 1)
  }
  const badge = lines.findLastIndex(line => REPOSITORY_BADGE.test(line))
  if (badge !== -1) {
    lines.splice(lines[badge - 1] === '' ? badge - 1 : badge, lines[badge - 1] === '' ? 2 : 1)
  }
  return lines.join('\n')
}

/**
 * 选择一页发布页实际渲染的 Markdown。
 *
 * @param markdown 已改写链接的定稿 Markdown 内容。
 * @param page 该内容的发布清单条目。
 * @returns 普通页面返回完整 Markdown；站点首页这类 `sidebar: null` 的重定向页只返回 frontmatter。
 */
export function projectedPageContent(markdown: string, page: DocsPage): string {
  if (page.sidebar !== null) return withoutRepositoryChrome(markdown)
  if (!markdown.startsWith('---\n')) {
    throw new Error(`project-doc-site: redirect home source ${JSON.stringify(page.source)} must start with YAML frontmatter.`)
  }
  const closingDelimiter = '\n---\n'
  const closing = markdown.indexOf(closingDelimiter, 4)
  if (closing === -1) {
    throw new Error(`project-doc-site: redirect home source ${JSON.stringify(page.source)} has unclosed YAML frontmatter.`)
  }
  return markdown.slice(0, closing + closingDelimiter.length)
}

/**
 * The repository file one image reference resolves to, or `undefined` when the
 * target is not a local file this build may publish.
 * @param absPath - resolved image target.
 * @param repoRoot - repository root every published image must stay inside.
 * @returns the file's real path, or `undefined` when it must not be copied.
 *
 * Only a regular file whose real path stays inside the repository qualifies.
 * Publication copies the bytes into the site, so a reference escaping the
 * repository — `../../.ssh/id_rsa`, or a symlink pointing out of the tree —
 * would put a build-machine file on the site; `existsSync` alone, which is all
 * link resolution needs, does not answer that.
 */
export function publishableImage(absPath: string, repoRoot: string): string | undefined {
  const real = realpathSync(absPath)
  const inside = real === repoRoot || real.startsWith(`${repoRoot}${sep}`)
  return inside && statSync(real).isFile() ? real : undefined
}

/** Every local image a published page references, resolved to its repository file. */
function referencedImages(): string[] {
  const found = new Set<string>()
  for (const page of docsPages) {
    const sourceAbs = resolve(root, page.source)
    if (!existsSync(sourceAbs)) continue
    rewriteMarkdown(readFileSync(sourceAbs, 'utf8'), {
      sourcePath: page.source,
      locale: page.locale,
      route: page.route,
      pages: docsPages,
      repoRoot: root,
      repositoryRef: 'master',
      placeImage: (absPath) => {
        const real = publishableImage(absPath, root)
        if (real !== undefined) found.add(real)
        return ''
      },
    })
  }
  return [...found]
}

/**
 * Files watched by the local VitePress dev server: every canonical Markdown
 * source, plus the images they publish. Without the images, replacing a
 * screenshot leaves the previous copy in the generated tree until something
 * touches the Markdown beside it.
 */
export function docsSourceFiles(): string[] {
  return [...new Set([...docsPages.map(page => resolve(root, page.source)), ...referencedImages()])]
}

/** Rebuild the disposable VitePress source tree from the publication manifest. */
export function projectDocs(): void {
  const routes = new Set<string>()
  /** Projected path to the repository file that claimed it, pages and images alike. */
  const claimed = new Map<string, string>()
  const repositoryRef = resolveRepositoryRef(process.env)
  rmSync(generatedRoot, { recursive: true, force: true })

  /** Reserve one projected path, refusing a second source for it. */
  const claim = (target: string, sourceAbs: string): void => {
    const holder = claimed.get(target)
    if (holder !== undefined && holder !== sourceAbs) {
      throw new Error(
        `project-doc-site: ${repoPath(sourceAbs, root)} and ${repoPath(holder, root)}`
        + ` both project to ${relative(generatedRoot, target).split(sep).join('/')}.`,
      )
    }
    claimed.set(target, sourceAbs)
  }

  for (const page of docsPages) {
    if (routes.has(page.route)) throw new Error(`project-doc-site: duplicate route ${JSON.stringify(page.route)}.`)
    routes.add(page.route)
    const sourceAbs = resolve(root, page.source)
    if (!existsSync(sourceAbs) || !lstatSync(sourceAbs).isFile()) {
      throw new Error(`project-doc-site: source ${JSON.stringify(page.source)} does not exist or is not a file.`)
    }
    const output = resolve(generatedRoot, page.route)
    // Claimed before the images are placed: a page and an image landing on one
    // path would otherwise overwrite each other in whichever order they ran.
    claim(output, sourceAbs)
    mkdirSync(dirname(output), { recursive: true })
    const markdown = readFileSync(sourceAbs, 'utf8')
    const projected = rewriteMarkdown(markdown, {
      sourcePath: page.source,
      locale: page.locale,
      route: page.route,
      pages: docsPages,
      repoRoot: root,
      repositoryRef,
      placeImage: (absPath) => {
        const real = publishableImage(absPath, root)
        if (real === undefined) {
          throw new Error(
            `project-doc-site: ${page.source} references image ${repoPath(absPath, root)},`
            + ' which is not a regular file inside the repository.',
          )
        }
        // Beside the page that references it, under its own basename: the
        // relative URL stays correct from the one route tree that serves it.
        const name = basename(real)
        const target = resolve(dirname(output), name)
        claim(target, real)
        copyFileSync(real, target)
        // Encoded because the destination is a Markdown inline target, where an
        // unescaped space would end it early.
        return `./${encodeURI(name)}`
      },
    })
    writeFileSync(output, addProjectionFrontmatter(projectedPageContent(projected, page), page))
  }
}
