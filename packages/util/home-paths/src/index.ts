/**
 * Coding 用户数据的共享路径辅助：主目录解析、环境变量优先级，以及首次启动从
 * `~/.dsh` 到 `~/.coding` 的自动迁移。
 *
 * @module @deepseek-ai/dsh-home-paths
 */

import { existsSync, readdirSync, statSync } from 'node:fs'
import { cp, opendir, readdir, realpath, rename, rm, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'

/** Coding 主目录在操作系统 home 下的默认名字。 */
export const CODING_HOME_DIR_NAME = '.coding'

/** DeepSeek Harness 遗留主目录名：只作为回退位置与迁移来源。 */
export const LEGACY_DSH_HOME_DIR_NAME = '.dsh'

/** 默认 Coding 主目录的稳定展示形式。 */
export const DEFAULT_CODING_HOME_DISPLAY = `~/${CODING_HOME_DIR_NAME}`

/** 遗留 DeepSeek Harness 主目录的稳定展示形式。 */
export const LEGACY_DSH_HOME_DISPLAY = `~/${LEGACY_DSH_HOME_DIR_NAME}`

/** 覆盖默认 Coding 主目录的环境变量，优先级最高。 */
export const CODING_HOME_ENV = 'CODING_HOME'

/** 兼容保留的 DeepSeek Harness 环境变量，优先级低于 {@link CODING_HOME_ENV}。 */
export const DSH_HOME_ENV = 'DSH_HOME'

/** 迁移成功后写在目标主目录里的标记文件名。 */
export const MIGRATION_MARKER_FILE = 'migration.json'

/** 迁移暂存目录名前缀，与目标主目录同级。 */
export const MIGRATION_TEMP_PREFIX = `${CODING_HOME_DIR_NAME}-migrating-`

const DEFAULT_MAX_MIGRATION_BYTES = 2 * 1024 * 1024 * 1024

/** 模型可见路径中所有已知的主目录展示前缀。 */
const HOME_DISPLAY_PREFIXES = [
  DEFAULT_CODING_HOME_DISPLAY,
  LEGACY_DSH_HOME_DISPLAY,
  `$${CODING_HOME_ENV}`,
  `$${DSH_HOME_ENV}`,
] as const

/**
 * Give a native filesystem watcher one canonical spelling of a path, even
 * when its final components do not exist yet. The deepest existing ancestor
 * is resolved through {@link realpath}; when a suffix is missing, that
 * ancestor is also proved to be an enumerable directory before the suffix is
 * restored. This prevents Windows from treating a regular-file ancestor as
 * ordinary absence, and prevents short-name aliases from being mixed with
 * long paths emitted by the native watcher backend.
 * @param path - Watch target or root, resolved against the current directory.
 * @returns the target with its existing ancestor canonicalized.
 * @throws when ancestor traversal encounters an error other than absence, or
 * the existing ancestor of a missing suffix is not an enumerable directory.
 */
export async function canonicalizeWatchPath(path: string): Promise<string> {
  let current = resolve(path)
  const missing: string[] = []
  while (true) {
    try {
      const canonical = await realpath(current)
      if (missing.length > 0) {
        // A Windows file-as-parent probe reports ENOENT. Opening the resolved
        // ancestor preserves the cross-platform directory requirement.
        const directory = await opendir(canonical)
        await directory.close()
      }
      return join(canonical, ...missing.reverse())
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      const parent = dirname(current)
      /* v8 ignore next -- a filesystem root exists, so traversal resolves before this guard */
      if (parent === current) throw error
      missing.push(basename(current))
      current = parent
    }
  }
}

/**
 * Resolve the default Coding home using Node's platform path rules.
 * @param homeDir - operating-system home to join; defaults to the current user's.
 * @returns the absolute default Coding home path.
 */
export function defaultCodingHome(homeDir: string = homedir()): string {
  return join(homeDir, CODING_HOME_DIR_NAME)
}

/**
 * Resolve the legacy DeepSeek Harness home, kept only as a fallback location and
 * as this fork's migration source.
 * @param homeDir - operating-system home to join; defaults to the current user's.
 * @returns the absolute legacy harness home path.
 */
export function legacyDshHome(homeDir: string = homedir()): string {
  return join(homeDir, LEGACY_DSH_HOME_DIR_NAME)
}

/**
 * Expand supported tilde prefixes against the operating-system home.
 * @param path - configured path that may begin with `~`, `~/`, or `~\`.
 * @returns the expanded path, or the original value when no supported prefix is present.
 */
export function expandHomePath(path: string): string {
  if (path === '~') return homedir()
  if (path.startsWith('~/') || path.startsWith('~\\')) return join(homedir(), path.slice(2))
  return path
}

/**
 * Decide whether a home directory holds user data. Absence, a non-directory, and
 * an empty directory all count as "no data": an empty `~/.coding` left by an
 * interrupted setup must not hide a populated `~/.dsh`.
 * @param path - candidate home directory.
 * @returns true when the directory exists and has at least one entry.
 */
export function homeHasData(path: string): boolean {
  try {
    return readdirSync(path).length > 0
  } catch {
    return false
  }
}

/**
 * Resolve the single-root Coding home.
 *
 * Precedence, highest first: an explicit configured path, `$CODING_HOME`,
 * `$DSH_HOME`, an already-populated `~/.coding`, a populated legacy `~/.dsh`,
 * then the `~/.coding` default that a fresh setup creates. A blank or
 * whitespace-only environment value is treated as unset, so it never resolves
 * the home to the current working directory.
 * @param configured - explicit harness-home override, which has highest precedence.
 * @param env - environment mapping used to read `CODING_HOME` and `DSH_HOME`.
 * @param homeDir - operating-system home used for default and legacy probing.
 * @returns the normalized absolute harness home path.
 */
export function resolveDshHome(
  configured?: string,
  env: Record<string, string | undefined> = process.env,
  homeDir: string = homedir(),
): string {
  if (configured !== undefined) return resolve(expandHomePath(configured))
  const fromEnv = firstSetHomeEnv(env)
  if (fromEnv !== undefined) return resolve(expandHomePath(fromEnv))
  const codingHome = resolve(defaultCodingHome(homeDir))
  if (homeHasData(codingHome)) return codingHome
  const legacyHome = resolve(legacyDshHome(homeDir))
  return homeHasData(legacyHome) ? legacyHome : codingHome
}

/**
 * Join path segments onto the resolved Coding home.
 * @param segments - path segments appended to the home; an empty list returns the home itself.
 * @returns the normalized absolute joined path.
 */
export function dshHomePath(...segments: string[]): string {
  return join(resolveDshHome(), ...segments)
}

/**
 * Describe a resolved home symbolically for user-facing display.
 *
 * It never returns an absolute machine path: the default Coding home is labelled
 * `~/.coding`, the legacy home `~/.dsh`, and any other home by the environment
 * variable that configured it.
 * @param resolvedHome - the absolute path returned by {@link resolveDshHome}.
 * @param env - environment mapping used to attribute a configured home.
 * @returns `~/.coding`, `~/.dsh`, `$CODING_HOME`, or `$DSH_HOME`.
 */
export function dshHomeDisplay(
  resolvedHome: string,
  env: Record<string, string | undefined> = process.env,
): string {
  const home = resolve(resolvedHome)
  if (home === resolve(defaultCodingHome())) return DEFAULT_CODING_HOME_DISPLAY
  if (home === resolve(legacyDshHome())) return LEGACY_DSH_HOME_DISPLAY
  if (matchesEnvHome(home, env[CODING_HOME_ENV])) return `$${CODING_HOME_ENV}`
  if (matchesEnvHome(home, env[DSH_HOME_ENV])) return `$${DSH_HOME_ENV}`
  // 既不是默认、也不是遗留、又对不上环境变量的主目录（例如代码里显式指定的路径）
  // 用当前产品的主变量名表示，避免让人以为它来自 DSH_HOME。
  return `$${CODING_HOME_ENV}`
}

/**
 * Decide whether a model-facing path lies inside the home directory, whatever
 * spelling it uses. Prompt producers print the home as one of
 * {@link HOME_DISPLAY_PREFIXES}, so a consumer that must recognize its own
 * user-global paths (rather than treating them as project paths) asks here
 * instead of hard-coding a spelling this package owns.
 * @param displayPath - model-facing path, absolute or symbolic.
 * @returns true when the path starts with a known home display prefix.
 */
export function isHomeDisplayPath(displayPath: string): boolean {
  return HOME_DISPLAY_PREFIXES.some(prefix => displayPath.startsWith(`${prefix}/`))
}

/** Result of one first-start migration attempt. */
export interface CodingHomeMigration {
  status: 'migrated' | 'not-needed' | 'explicit-home' | 'too-large' | 'failed'
  /** Home the caller must use now: `~/.coding` after success, else the legacy home. */
  home: string
  legacyHome: string
  /** One-line diagnostic naming the reason, safe to log. */
  detail: string
  entries?: number
  bytes?: number
}

/** Options for {@link migrateCodingHome}. */
export interface MigrateCodingHomeOptions {
  env?: Record<string, string | undefined>
  homeDir?: string
  /** Byte cap above which the legacy home is left for a manual migration. */
  maxBytes?: number
}

/**
 * 首次启动把有数据的遗留 `~/.dsh` 复制到 `~/.coding`。
 * 旧目录只读不删；副本先写入同级暂存目录，按条目数和字节数校验后原子改名就位，因此中断或失败不会留下会被解析器优先选中的半成品目录。
 * 迁移只受字节上限约束，不会因为旧目录包含大量小文件而拒绝，也会复制可重建的运行时缓存。
 * @param options - 环境变量、操作系统主目录和迁移字节上限。
 * @returns 迁移结果，包括调用方应继续使用的主目录。
 */
export async function migrateCodingHome(
  options: MigrateCodingHomeOptions = {},
): Promise<CodingHomeMigration> {
  const env = options.env ?? process.env
  const homeDir = options.homeDir ?? homedir()
  const target = resolve(defaultCodingHome(homeDir))
  const legacy = resolve(legacyDshHome(homeDir))
  const resolved = (status: CodingHomeMigration['status'], home: string, detail: string): CodingHomeMigration =>
    ({ status, home, legacyHome: legacy, detail })

  if (firstSetHomeEnv(env) !== undefined) {
    // 调用方拿返回的 home 直接用，所以这里必须给出环境变量真正选中的路径，
    // 而不是默认目录。
    return resolved(
      'explicit-home',
      resolveDshHome(undefined, env, homeDir),
      `$${CODING_HOME_ENV}/$${DSH_HOME_ENV} selects the home; leaving ${LEGACY_DSH_HOME_DISPLAY} untouched`,
    )
  }
  if (homeHasData(target)) {
    return resolved('not-needed', target, `${DEFAULT_CODING_HOME_DISPLAY} already holds user data`)
  }
  if (!homeHasData(legacy)) {
    return resolved('not-needed', target, `no ${LEGACY_DSH_HOME_DISPLAY} data to migrate`)
  }
  if (existsSync(target) && !statSync(target).isDirectory()) {
    return resolved('failed', legacy, `${DEFAULT_CODING_HOME_DISPLAY} exists and is not a directory`)
  }

  const measured = await measureTree(legacy)
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_MIGRATION_BYTES
  if (measured.bytes > maxBytes) {
    return {
      ...resolved(
        'too-large',
        legacy,
        `${LEGACY_DSH_HOME_DISPLAY} holds ${measured.bytes} bytes, above the automatic migration cap; set $${CODING_HOME_ENV} or move it to ${DEFAULT_CODING_HOME_DISPLAY} manually`,
      ),
      ...measured,
    }
  }

  const staging = join(homeDir, `${MIGRATION_TEMP_PREFIX}${process.pid}`)
  try {
    await rm(staging, { recursive: true, force: true })
    await cp(legacy, staging, { recursive: true, force: true, verbatimSymlinks: true, preserveTimestamps: true })
    const copied = await measureTree(staging)
    if (copied.entries !== measured.entries || copied.bytes !== measured.bytes) {
      throw new Error(`copied ${copied.entries} entries / ${copied.bytes} bytes, expected ${measured.entries} / ${measured.bytes}`)
    }
    await rm(target, { recursive: true, force: true })
    await rename(staging, target)
    await writeFile(
      join(target, MIGRATION_MARKER_FILE),
      `${JSON.stringify({
        migratedFrom: legacy,
        migratedAt: new Date().toISOString(),
        entries: measured.entries,
        bytes: measured.bytes,
      }, null, 2)}\n`,
      'utf8',
    )
    return {
      ...resolved('migrated', target, `copied ${LEGACY_DSH_HOME_DISPLAY} to ${DEFAULT_CODING_HOME_DISPLAY}`),
      ...measured,
    }
  } catch (error) {
    await rm(staging, { recursive: true, force: true }).catch(() => undefined)
    return {
      ...resolved('failed', legacy, `migration failed, continuing on ${LEGACY_DSH_HOME_DISPLAY}: ${describeError(error)}`),
      ...measured,
    }
  }
}

async function measureTree(root: string): Promise<{ entries: number; bytes: number }> {
  let entries = 0
  let bytes = 0
  const pending: string[] = [root]
  while (pending.length > 0) {
    const directory = pending.pop()
    /* v8 ignore next -- the loop condition already proved an element exists. */
    if (directory === undefined) break
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      entries += 1
      const path = join(directory, entry.name)
      if (entry.isDirectory()) pending.push(path)
      else if (entry.isFile()) bytes += (await stat(path)).size
    }
  }
  return { entries, bytes }
}

function firstSetHomeEnv(env: Record<string, string | undefined>): string | undefined {
  for (const key of [CODING_HOME_ENV, DSH_HOME_ENV]) {
    const value = env[key]
    if (value !== undefined && value.trim().length > 0) return value
  }
  return undefined
}

function matchesEnvHome(home: string, value: string | undefined): boolean {
  return value !== undefined && value.trim().length > 0 && resolve(expandHomePath(value)) === home
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
