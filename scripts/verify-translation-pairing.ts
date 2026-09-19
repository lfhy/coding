/**
 * 校验仍存在的历史中英配对：三件套完整、结构一致且 Git blob hash 与记录匹配。
 * 普通中文 `.md` 不进入发现范围；语料检查只从 `.zh.md` 或 `.i18n.yaml`
 * 反查 owner。`--list` 报告 legacy pair 状态，`--write` 只重录显式确认的配对，
 * `--cached` 供 hook 校验 index 中的精确字节。语义翻译质量仍由评审负责。
 * 所属约定见 `docs/i18n/README.md`。
 */

import { existsSync, globSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, join, resolve, sep } from 'node:path'
import { gitBlobHash, readGitIndexBlob, storeGitBlob } from './translation-pairing-git.ts'
import {
  parseTranslationPairingRecord,
  renderTranslationPairingRecord,
  translationPairPaths,
} from './translation-pairing-record.ts'
import {
  languageSwitcherTargets,
  linksTo,
  parseTranslationMarkdown,
  parseTranslationPairingCliArgs,
  parseTranslationPairingManifest,
  partitionGeneratedRegions,
  requiresSourceLanguageSwitcher,
  isTranslationScopeFile,
  TRANSLATION_SCOPE_GLOB_EXCLUDES,
  translationStructureDiff,
  translationStructureSignature,
} from './translation-pairing.ts'

const root = resolve(import.meta.dirname, '..')
let request: ReturnType<typeof parseTranslationPairingCliArgs>
try {
  request = parseTranslationPairingCliArgs(process.argv.slice(2))
} catch (error) {
  console.error(`verify-translation-pairing: ${error instanceof Error ? error.message : String(error)}`)
  process.exit(2)
}
const listMode = request.mode === 'list'
const writeMode = request.mode === 'write'
const indexMode = request.input === 'index'

const contentCache = new Map<string, Buffer | undefined>()

/** Read one repository path from the selected worktree or index plane. */
function readRepositoryFile(file: string): Buffer | undefined {
  if (contentCache.has(file)) return contentCache.get(file)
  const content = indexMode
    ? readGitIndexBlob(root, file)?.content
    : existsSync(join(root, file)) ? readFileSync(join(root, file)) : undefined
  contentCache.set(file, content)
  return content
}

/** Whether one path exists in the selected content plane. */
function repositoryFileExists(file: string): boolean {
  return readRepositoryFile(file) !== undefined
}

/** 只发现历史配对产物；无后缀 owner 由产物路径推导并按需读取。 */
const SCOPE_PATTERNS = [
  '**/*.zh.md',
  '**/*.i18n.yaml',
  '.agents/notes/**/*.zh.md',
  '.agents/notes/**/*.i18n.yaml',
]

const manifestContent = readRepositoryFile('scripts/translation-pairing.manifest.json')
if (manifestContent === undefined) {
  throw new Error('scripts/translation-pairing.manifest.json is missing from the selected content plane')
}
const manifest = parseTranslationPairingManifest(manifestContent.toString('utf8'))

/**
 * An excluded entry ending in `/` excludes the whole directory. The trailing
 * slash IS the path boundary — `docs/tool-catalog/` cannot prefix-match a
 * sibling like `docs/tool-catalog-notes/x.md` — so directory entries in the
 * manifest must keep their trailing slash.
 */
function isExcluded(file: string): boolean {
  return manifest.excluded.some(entry => (entry.endsWith('/') ? file.startsWith(entry) : file === entry))
}

// Enumerate the scope once: the whole corpus, or exactly the named pairs'
// three files (a named pair whose files are absent is caught by the same
// completeness rules that cover discovered remnants).
const files = new Set<string>()
if (request.scope === 'pairs') {
  for (const anchor of request.anchors) {
    const { source, zh, meta } = translationPairPaths(anchor)
    for (const file of [source, zh, meta]) {
      if (repositoryFileExists(file)) files.add(file)
    }
    // A named worktree anchor with no files still enters the source list so
    // an interactive check reports it. An index check accepts a complete
    // three-file deletion and still rejects every partial deletion below.
    if (!indexMode && !repositoryFileExists(anchor)) files.add(anchor)
  }
} else {
  for (const pattern of SCOPE_PATTERNS) {
    for (const match of globSync(pattern, { cwd: root, exclude: TRANSLATION_SCOPE_GLOB_EXCLUDES })) {
      const normalized = match.split(sep).join('/')
      if (isTranslationScopeFile(normalized)) files.add(normalized)
    }
  }
}
const translations = [...files].filter(f => f.endsWith('.zh.md')).sort()
const metas = [...files].filter(f => f.endsWith('.i18n.yaml')).sort()

// 任一历史产物都锚定一对文档；完整删除 `.zh.md` 与 sidecar 后，留下的
// 中文 canonical 不再进入本门禁。
const pairAnchors = new Set<string>()
for (const zh of translations) pairAnchors.add(zh.replace(/\.zh\.md$/, '.md'))
for (const meta of metas) pairAnchors.add(meta.replace(/\.i18n\.yaml$/, '.md'))

if (request.scope === 'pairs') {
  const rejected = request.anchors.filter(anchor => !isTranslationScopeFile(anchor) || isExcluded(anchor))
  const absent = request.anchors.filter((anchor) => {
    const { source, zh, meta } = translationPairPaths(anchor)
    return ![source, zh, meta].some(repositoryFileExists)
  })
  if (rejected.length > 0 || (!indexMode && absent.length > 0)) {
    for (const anchor of rejected) {
      console.error(`verify-translation-pairing: ${anchor} is not an in-scope pair (excluded or outside the documentation corpus; see docs/i18n/README.md)`)
    }
    for (const anchor of absent) {
      console.error(`verify-translation-pairing: ${anchor} names no pair on disk (none of its three files exist)`)
    }
    process.exit(2)
  }
}

// `--write` 只处理显式点名或已被历史产物锚定的配对。普通中文单文档
// 即使处于全仓范围，也不会在 `--all` 中获得新 sidecar。
if (writeMode) {
  let written = 0
  const writeAnchors = request.scope === 'pairs' ? new Set(request.anchors) : pairAnchors
  for (const source of [...writeAnchors].sort()) {
    if (isExcluded(source)) continue
    const paths = translationPairPaths(source)
    const { zh, meta } = paths
    if (!repositoryFileExists(source) || !repositoryFileExists(zh)) {
      console.error(`verify-translation-pairing: cannot record ${source}: missing ${repositoryFileExists(source) ? zh : source}`)
      process.exit(2)
    }
    const sourceContent = readRepositoryFile(source)
    const zhContent = readRepositoryFile(zh)
    if (sourceContent === undefined || zhContent === undefined) throw new Error(`${source}: complete pair became unreadable`)
    // A consistency record is also a recovery pointer for the briefing
    // generator. Persist both snapshots even when the sidecar text is already
    // current, because the bytes may exist only in this working tree.
    const record = renderTranslationPairingRecord(paths, {
      sourceHash: storeGitBlob(root, sourceContent),
      zhHash: storeGitBlob(root, zhContent),
    })
    if (existsSync(join(root, meta)) && readFileSync(join(root, meta), 'utf8') === record) continue
    writeFileSync(join(root, meta), record)
    console.log(`verify-translation-pairing: recorded ${meta}`)
    written++
  }
  console.log(`verify-translation-pairing: ${written} record(s) written; run the check to validate the pairs.`)
  process.exit(0)
}

const errors: string[] = []
const state = new Map<string, 'ok' | 'out-of-sync' | 'missing'>()

// 任何仍有历史产物的配对都必须完整且一致；残留 `.zh.md` 或 sidecar
// 都足以发现一次不完整迁移。
for (const source of [...pairAnchors].sort()) {
  const paths = translationPairPaths(source)
  const { zh, meta } = paths
  const have = {
    source: repositoryFileExists(source),
    zh: repositoryFileExists(zh),
    meta: repositoryFileExists(meta),
  }

  if (isExcluded(source)) {
    if (have.zh) errors.push(`${zh}: ${source} is excluded from pairing (generated or bilingual-by-construction); this translation must not exist`)
    if (have.meta) errors.push(`${meta}: ${source} is excluded from pairing; this consistency record must not exist`)
    state.set(source, 'out-of-sync')
    continue
  }
  const missing = Object.entries(have).filter(([, ok]) => !ok).map(([k]) => (k === 'source' ? source : k === 'zh' ? zh : meta))
  if (missing.length > 0) {
    errors.push(`${source}: incomplete pair — missing ${missing.join(', ')} (pairs merge whole: both languages plus the .i18n.yaml record)`)
    state.set(source, 'missing')
    continue
  }

  const sourceContent = readRepositoryFile(source)
  const zhContent = readRepositoryFile(zh)
  const metaContent = readRepositoryFile(meta)
  if (sourceContent === undefined || zhContent === undefined || metaContent === undefined) {
    throw new Error(`${source}: complete pair became unreadable`)
  }
  const record = parseTranslationPairingRecord(metaContent.toString('utf8'), paths)
  if (record === undefined) {
    errors.push(`${meta}: malformed consistency record (expected exactly \`${basename(source)}: <40-hex>\` and \`${basename(zh)}: <40-hex>\`)`)
    continue
  }

  let consistent = true
  for (const [file, content] of [[source, sourceContent], [zh, zhContent]] as const) {
    const current = gitBlobHash(content)
    const recorded = file === source ? record.sourceHash : record.zhHash
    if (recorded !== current) {
      errors.push(`${file}: out of sync — content no longer matches the pair's last confirmed-consistent state in ${meta} (bring the other side along, then re-record with --write)`)
      consistent = false
    }
  }
  if (!consistent) {
    state.set(source, 'out-of-sync')
    continue
  }

  // Generated regions are language-invariant: the exact same generator output
  // (markers included) must appear in both sides, in the same order. The
  // structural signature below compares the region content again as part of
  // the whole document; this dedicated check exists to name the divergence
  // precisely and to reject a region grammar violation on either side.
  let sourceRegions: { regions: string[]; stripped: string }
  let zhRegions: { regions: string[]; stripped: string }
  try {
    sourceRegions = partitionGeneratedRegions(sourceContent.toString('utf8'))
    zhRegions = partitionGeneratedRegions(zhContent.toString('utf8'))
  } catch (error) {
    errors.push(`${source} ↔ ${zh}: ${error instanceof Error ? error.message : String(error)}`)
    state.set(source, 'out-of-sync')
    continue
  }
  if (sourceRegions.regions.length !== zhRegions.regions.length
    || sourceRegions.regions.some((region, index) => region !== zhRegions.regions[index])) {
    errors.push(`${source} ↔ ${zh}: generated regions differ between the pair — regenerate (the generator writes both sides byte-identically)`)
    state.set(source, 'out-of-sync')
  }

  const sourceTree = parseTranslationMarkdown(sourceContent.toString('utf8'))
  const zhTree = parseTranslationMarkdown(zhContent.toString('utf8'))
  const sourceSwitcherTargets = languageSwitcherTargets(source)
  const zhSwitcherTargets = languageSwitcherTargets(zh)
  if (!linksTo(zhTree, sourceSwitcherTargets)) {
    errors.push(`${zh}: missing language switcher — no link to ${basename(source)}`)
  }
  if (requiresSourceLanguageSwitcher(source) && !linksTo(sourceTree, zhSwitcherTargets)) {
    errors.push(`${source}: missing language switcher — no link back to ${basename(zh)}`)
  }
  for (const divergence of translationStructureDiff(
    translationStructureSignature(sourceTree, zhSwitcherTargets),
    translationStructureSignature(zhTree, sourceSwitcherTargets),
  )) {
    errors.push(`${source} ↔ ${zh}: ${divergence}`)
  }
  if (!state.has(source)) state.set(source, 'ok')
}

if (listMode) {
  const order = { 'out-of-sync': 0, missing: 1, ok: 2 } as const
  const rows = [...state.entries()].sort((a, b) => order[a[1]] - order[b[1]] || a[0].localeCompare(b[0]))
  for (const [file, status] of rows) {
    console.log(`${status.padEnd(11)} ${file}${status === 'missing' ? '  (required)' : ''}`)
  }
  const counts = { 'ok': 0, 'out-of-sync': 0, 'missing': 0 }
  for (const status of state.values()) counts[status]++
  console.log(`verify-translation-pairing: ${counts.ok} ok, ${counts['out-of-sync']} out-of-sync, ${counts.missing} missing (of ${state.size} legacy pair(s))`)
  process.exit(0)
}

if (errors.length === 0) {
  console.log(request.scope === 'pairs'
    ? `verify-translation-pairing: ${pairAnchors.size} named ${indexMode ? 'staged ' : ''}pair(s) consistent; the corpus-wide check still runs in doc-sync.`
    : `verify-translation-pairing: ${pairAnchors.size} legacy pair(s) checked, all consistent; standalone Chinese Markdown is outside this gate.`)
  process.exit(0)
}

console.error('verify-translation-pairing: legacy bilingual pairing rules violated (see docs/i18n/README.md):')
for (const message of errors) console.error(`  ${message}`)
process.exit(1)
