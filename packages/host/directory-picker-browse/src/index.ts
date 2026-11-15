/**
 * Browse backend of the directory-picker seam: registers `ctx.directoryPicker`
 * with the `browse` capability — one-level listing (child directories and
 * files), child-directory creation, same-parent rename, and removal, all over
 * the host filesystem via Node's stdlib (which already carries the per-OS
 * adaptation). Nothing renders on the host display, so this backend serves
 * remote clients the dialog backend cannot. Policy decisions (hidden entries
 * flagged but returned, symlinks followed, whole-filesystem scope, no
 * confirmation for the destructive primitive) are recorded in the
 * directory-picker seam design record.
 * @module coding-host-directory-picker-browse
 */

import { mkdir, opendir, rename, rm, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, join, posix, resolve, win32 } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import {
  DirectoryPicker, DirectoryPickerError,
} from 'coding-host-directory-picker'
import type {
  DirectoryEntry, DirectoryListing, DirectoryPickerCapability,
} from 'coding-host-directory-picker'

/**
 * Ancestor chain from the filesystem root to `target` inclusive — the
 * breadcrumb rows of a listing, every one a jump target.
 */
function ancestryCrumbs(target: string): DirectoryEntry[] {
  const crumbs: DirectoryEntry[] = []
  let current = target
  for (;;) {
    const parent = dirname(current)
    // basename of a root is '' — label the root crumb by its full path ('/', 'C:\').
    crumbs.unshift({ name: parent === current ? current : basename(current), path: current, hidden: false })
    if (parent === current) return crumbs
    current = parent
  }
}

/**
 * True when the path names one fixed filesystem location regardless of
 * process state: POSIX-absolute on POSIX; on Windows only drive-qualified
 * (`C:\…`) or complete UNC (`\\server\share…`) forms. Rooted drive-less
 * forms (`\foo`, `/foo`) and incomplete UNC prefixes (`\\`, `\\server`)
 * pass `isAbsolute` yet still resolve against the process's current drive.
 * @param path - candidate path.
 * @param platform - replaces `process.platform` for deterministic tests.
 * @returns whether the path is fully qualified on the platform.
 */
export function fullyQualified(path: string, platform: NodeJS.Platform = process.platform): boolean {
  return platform === 'win32'
    ? win32.isAbsolute(path) && /^(?:[A-Za-z]:[\\/]|[\\/]{2}[^\\/]+[\\/]+[^\\/]+)/.test(path)
    : posix.isAbsolute(path)
}

/**
 * One streamed listing candidate: the dirent facts a row needs, nothing else
 * retained. A plain file arrives with both flags false; a symlink needs a
 * `stat` probe to decide between a directory row, a file row, and no row.
 */
export interface ListingCandidate {
  /** Base name within the streamed level. */
  name: string
  /** Dirent says directory (no probe needed). */
  isDirectory: boolean
  /** Dirent says symlink (its directory/file nature needs a stat probe). */
  isSymbolicLink: boolean
}

/**
 * Insert a streamed candidate into the name-sorted bounded window, evicting
 * the name-largest candidate when the window exceeds `keep`. Memory over an
 * arbitrarily large level therefore stays O(keep) regardless of how many
 * children the directory holds.
 * @param window - the name-ascending window, mutated in place.
 * @param candidate - the streamed candidate to place.
 * @param keep - the window bound.
 * @returns true when an eviction happened (the level has candidates beyond the window).
 */
export function boundedInsert(window: ListingCandidate[], candidate: ListingCandidate, keep: number): boolean {
  // Full window, name at or beyond the tail: one comparison rejects, so an
  // oversized level costs O(1) per candidate past the head instead of a
  // window scan (100k children against a 1,001 window must not approach
  // 10^8 comparisons).
  // oxlint-disable-next-line typescript/no-non-null-assertion -- a full window (length === keep >= 1) has a tail
  if (window.length === keep && candidate.name.localeCompare(window[window.length - 1]!.name) >= 0) return true
  // Binary insertion keeps a retained candidate at O(log keep) comparisons.
  let lo = 0
  let hi = window.length
  while (lo < hi) {
    const mid = (lo + hi) >>> 1
    // oxlint-disable-next-line typescript/no-non-null-assertion -- bounded by the loop condition
    if (candidate.name.localeCompare(window[mid]!.name) < 0) hi = mid
    else lo = mid + 1
  }
  window.splice(lo, 0, candidate)
  if (window.length <= keep) return false
  window.pop()
  return true
}

/**
 * Await `operation`, but reject with the signal's reason the moment it
 * aborts. Node's filesystem reads are not retractable, so the operation
 * itself keeps running against a handle the caller then closes — its late
 * settlement is swallowed here so an abandoned read cannot surface as an
 * unhandled rejection.
 * @param operation - the in-flight filesystem step.
 * @param signal - caller lifetime; absent means plain awaiting.
 * @returns the operation's value.
 */
export function raceAbort<T>(operation: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (signal === undefined) return operation
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => {
      operation.catch(() => {
        // Abandoned read: its handle is being closed by the aborting caller,
        // and the abort reason already carried the outcome.
      })
      reject(asError(signal.reason))
    }
    if (signal.aborted) {
      onAbort()
      return
    }
    signal.addEventListener('abort', onAbort, { once: true })
    operation.then(
      (value) => {
        signal.removeEventListener('abort', onAbort)
        resolve(value)
      },
      (reason: unknown) => {
        signal.removeEventListener('abort', onAbort)
        reject(asError(reason))
      },
    )
  })
}

/** The thrown value as an Error (wire/abort reasons may be anything). */
function asError(reason: unknown): Error {
  return reason instanceof Error ? reason : new Error(String(reason))
}

/* v8 ignore start -- a close failure of an abandoned handle has no consumer, and forcing one needs a filesystem torn down mid-request. */
/** Swallow the close failure of a handle its caller already departed. */
function swallowCloseFailure(): void {}
/* v8 ignore stop */

/** Message text of an unknown thrown value. */
function messageOf(error: unknown): string {
  /* v8 ignore next -- node:fs rejects with Error instances; the String arm only satisfies the unknown narrowing. */
  return error instanceof Error ? error.message : String(error)
}

/** 一次文件系统失败的 errno（非标准错误或被包装过的值返回 undefined）。 */
function errnoOf(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string'
    ? error.code
    : undefined
}

/** 名称是否为同层里的单个路径段：非空白、不是 `.`／`..`、不含分隔符。 */
function isPathSegment(name: string): boolean {
  return name.trim() !== '' && name !== '.' && name !== '..' && !/[/\\]/.test(name)
}

/** 已解析的一行：目录行进入 `entries`（可挑选），文件行进入 `files`（只读展示）。 */
interface ResolvedRow {
  /** 行归属：目录可被进入与挑选，文件只用于展示。 */
  kind: 'directory' | 'file'
  /** 该行在列举里的条目（路径已由宿主拼好）。 */
  entry: DirectoryEntry
}

/**
 * Resolve one streamed candidate into a directory row, a file row, or no row.
 * Plain dirents need no probe; a symlink is probed once (never once per kind)
 * and a broken or cyclic link resolves to nothing — the browser shows what it
 * can act on, and a link to nothing cannot be entered, picked, or opened.
 */
async function resolveRow(
  parent: string, name: string, isDirectory: boolean, isSymbolicLink: boolean, signal: AbortSignal | undefined,
): Promise<ResolvedRow | null> {
  const path = join(parent, name)
  let kind: ResolvedRow['kind'] | null = isDirectory ? 'directory' : isSymbolicLink ? null : 'file'
  if (kind === null) {
    try {
      // The probe races the caller too: a symlink target on a stalled
      // network filesystem must not keep a departed caller's request alive.
      const stats = await raceAbort(stat(path), signal)
      kind = stats.isDirectory() ? 'directory' : stats.isFile() ? 'file' : null
    } catch {
      /* v8 ignore next 2 -- an abort landing mid-probe needs a stalled stat; the per-candidate check in list covers the settled path. */
      if (signal?.aborted) throw asError(signal.reason)
      // Broken or cyclic symlink: stat is the probe, failure means "no row".
      return null
    }
  }
  if (kind === null) return null
  // POSIX hidden convention; Windows' hidden attribute is not exposed by
  // dirents (Known Limitations). The client owns whether hidden rows show.
  return { kind, entry: { name, path, hidden: name.startsWith('.') } }
}

/** Validated plugin configuration. */
export interface Config {
  /** Complete-result bound of one listing level; see {@link BrowseDirectoryPicker.Config}. */
  maxEntries: number
}

/** The `ctx.directoryPicker` browse implementation (stable capability object per service life). */
export default class BrowseDirectoryPicker extends DirectoryPicker {
  /**
   * `maxEntries` bounds the complete listing level a single `list` call may
   * materialize and put on the wire: at most this many rows in total, child
   * directories and files together (hidden rows included), with `truncated`
   * flagging a cut level. The default follows GitHub's web UI, which
   * truncates directory listings at 1,000 entries.
   */
  static Config: z<Config> = z.object({
    maxEntries: z.natural().min(1).default(1000),
  })

  private readonly browseCapability: DirectoryPickerCapability = {
    kind: 'browse',
    list: (path, signal) => this.list(path, signal),
    createDirectory: (path, name) => this.createDirectory(path, name),
    rename: (path, nextName) => this.rename(path, nextName),
    remove: path => this.remove(path),
  }

  constructor(ctx: Context, private readonly config: Config) {
    super(ctx)
  }

  /**
   * The browse interaction capability.
   * @returns the stable `browse` capability object.
   */
  capability(): DirectoryPickerCapability {
    return this.browseCapability
  }

  private async list(path?: string, signal?: AbortSignal): Promise<DirectoryListing> {
    const home = homedir()
    // The seam contract takes fully qualified paths only; resolve() would
    // silently rebase a relative or empty wire value under the host process
    // cwd (or, for rooted drive-less Windows forms, its current drive).
    if (path !== undefined && !fullyQualified(path)) {
      throw new DirectoryPickerError('directory-unreadable', path, `cannot list "${path}": not a fully qualified path`)
    }
    const target = resolve(path ?? home)
    // Stream the level (opendir, one dirent at a time) into ONE name-sorted
    // window over directories and files together: memory stays bounded no
    // matter how many children the directory holds, the window keeps the
    // name-sorted head of the combined set, and the +1 slot lets an in-window
    // extra row prove the cut. One window (not one per kind) is what keeps
    // `truncated` honest: the bound applies to the level as the browser shows
    // it, so a level of 600 files beside 600 directories cannot report
    // "complete" twice over. A window candidate that resolves to no row
    // (broken symlink) is not backfilled from beyond the window — an eviction
    // already marks the level truncated, which stays the honest answer.
    const keep = this.config.maxEntries + 1
    const window: ListingCandidate[] = []
    let evicted = false
    try {
      // Every filesystem await races the caller's signal: a stalled
      // opendir/read on a network filesystem must not keep a departed
      // caller's scan alive, and an already-aborted request rejects even
      // when the level is empty.
      const opening = opendir(target)
      const level = await raceAbort(opening, signal).catch((error: unknown) => {
        // The abandoned open can still mint a handle after the abort won;
        // close it so a departed caller cannot leak a descriptor. (A lost
        // race against opendir's own rejection has nothing to close, and
        // the close's own failure is swallowed — the request already
        // returned, so a cleanup error has no consumer.)
        void opening.then(dir => dir.close().catch(swallowCloseFailure), () => {
          // Already rejected: raceAbort surfaced or swallowed it.
        })
        throw error
      })
      try {
        for (;;) {
          const dirent = await raceAbort(level.read(), signal)
          if (dirent === null) break
          // Every child contends for the window: a plain dirent already says
          // whether it is a directory or a file, so no row costs a probe.
          const candidate = { name: dirent.name, isDirectory: dirent.isDirectory(), isSymbolicLink: dirent.isSymbolicLink() }
          if (boundedInsert(window, candidate, keep)) evicted = true
        }
      } finally {
        // Manual read() never auto-closes; close on every exit. The aborted
        // exit must not await it — Node queues close behind any in-flight
        // read, so awaiting would chain the departed caller back onto the
        // very stall the abort escaped (the abandoned read's settlement is
        // already swallowed by raceAbort).
        const closing = level.close()
        /* v8 ignore next 3 -- an abort between open and close needs a stalled read; the abandoned-close arm has no observable outcome. */
        if (signal?.aborted) {
          closing.catch(swallowCloseFailure)
        } else {
          await closing
        }
      }
    } catch (error: unknown) {
      // An abort is the caller's own reason, not an unreadable directory.
      signal?.throwIfAborted()
      throw new DirectoryPickerError('directory-unreadable', target, `cannot list ${target}: ${messageOf(error)}`)
    }
    const entries: DirectoryEntry[] = []
    const files: DirectoryEntry[] = []
    let truncated = evicted
    for (const candidate of window) {
      // A caller that departed between reads and probes stops before the
      // next probe (each probe's own await is raced inside resolveRow).
      signal?.throwIfAborted()
      const row = await resolveRow(target, candidate.name, candidate.isDirectory, candidate.isSymbolicLink, signal)
      if (row === null) continue
      // The bound counts the complete level — directories and files together.
      if (entries.length + files.length === this.config.maxEntries) {
        truncated = true
        break
      }
      if (row.kind === 'directory') entries.push(row.entry)
      else files.push(row.entry)
    }
    return { path: target, home, crumbs: ancestryCrumbs(target), entries, files, truncated }
  }

  private async createDirectory(path: string, name: string): Promise<string> {
    // Same fully-qualified fence as list: never rebase a parent under the
    // cwd or the current drive.
    if (!fullyQualified(path)) {
      throw new DirectoryPickerError('directory-create-failed', path, `cannot create under "${path}": not a fully qualified parent path`)
    }
    const parent = resolve(path)
    // The backend owns segment validation (the wire schema also refuses these,
    // but direct service consumers must hit the same fence).
    if (!isPathSegment(name)) {
      throw new DirectoryPickerError('directory-create-failed', join(parent, name), `"${name}" is not a single path segment`)
    }
    const target = join(parent, name)
    try {
      // Non-recursive: the parent is the directory the browser is showing, so
      // a missing parent is a real failure, not a level to invent.
      await mkdir(target)
      return target
    } catch (error: unknown) {
      if (errnoOf(error) === 'EEXIST') {
        throw new DirectoryPickerError('directory-exists', target, `${target} already exists`)
      }
      throw new DirectoryPickerError('directory-create-failed', target, `cannot create ${target}: ${messageOf(error)}`)
    }
  }

  private async rename(path: string, nextName: string): Promise<string> {
    // Same fully-qualified fence as list/create: never rebase a wire value
    // under the host process cwd or its current drive.
    if (!fullyQualified(path)) {
      throw new DirectoryPickerError('directory-rename-failed', path, `cannot rename "${path}": not a fully qualified path`)
    }
    const source = resolve(path)
    const parent = dirname(source)
    if (!isPathSegment(nextName)) {
      throw new DirectoryPickerError(
        'directory-rename-failed', join(parent, nextName), `"${nextName}" is not a single path segment`,
      )
    }
    const target = join(parent, nextName)
    // Submitting the current name unchanged is a no-op, not a conflict: the
    // dialog prefills the entry's own name, and Enter on it must not report
    // the sibling it already is.
    if (target === source) return source
    try {
      // POSIX rename(2) silently REPLACES an existing target, so the conflict
      // is refused here instead. A target that resolves to the entry itself is
      // the case-only rename a case-insensitive volume offers (macOS, Windows)
      // — same device and inode means the operator is respelling this very
      // entry, not colliding with a sibling.
      const existing = await stat(target).catch(() => undefined)
      if (existing !== undefined) {
        const current = await stat(source).catch(() => undefined)
        const sameEntry = current !== undefined && current.dev === existing.dev && current.ino === existing.ino
        if (!sameEntry) {
          throw new DirectoryPickerError('directory-exists', target, `${target} already exists`)
        }
      }
      await rename(source, target)
      return target
    } catch (error: unknown) {
      if (error instanceof DirectoryPickerError) throw error
      throw new DirectoryPickerError(
        'directory-rename-failed',
        source,
        errnoOf(error) === 'ENOENT'
          ? `cannot rename ${source}: no such file or directory`
          : `cannot rename ${source}: ${messageOf(error)}`,
      )
    }
  }

  private async remove(path: string): Promise<void> {
    if (!fullyQualified(path)) {
      throw new DirectoryPickerError('directory-delete-failed', path, `cannot delete "${path}": not a fully qualified path`)
    }
    const target = resolve(path)
    try {
      // Recursive by contract: a directory goes with everything inside it.
      // The confirmation the operator saw is the caller's obligation, and the
      // browser owns it before this primitive is ever reached.
      await rm(target, { recursive: true })
    } catch (error: unknown) {
      throw new DirectoryPickerError(
        'directory-delete-failed',
        target,
        errnoOf(error) === 'ENOENT'
          ? `cannot delete ${target}: no such file or directory`
          : `cannot delete ${target}: ${messageOf(error)}`,
      )
    }
  }
}
