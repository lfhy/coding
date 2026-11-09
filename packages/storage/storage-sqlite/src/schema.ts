/**
 * Schema + open-time helpers for the SQLite storage backend: the physical
 * layout version, the database open/configure sequence (permissions, pragmas,
 * version stamp/reject), and the unit metadata tables. Unit record tables are
 * created per descriptor in `unit.ts`.
 * @module coding-storage-sqlite/schema
 */

import { DatabaseSync } from 'node:sqlite'
import { lstat, mkdir, open } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { StorageError } from 'coding-storage'

/**
 * The on-disk physical layout version, stored in `PRAGMA user_version`.
 * Orthogonal to each unit's own `version` (stamped per unit in the `units`
 * row). Bumped only on a breaking change to the table layout; any other
 * stamped version rejects — this unreleased format has no migrations.
 */
export const STORAGE_SQLITE_SCHEMA_VERSION = 1

/**
 * Journal modes the backend will run under. `wal` is the default; the
 * rollback-journal modes (`delete`/`truncate`/`persist`) exist for
 * filesystems where WAL's shared-memory files do not work (network mounts).
 * `memory`/`off` are excluded: dropping journal durability silently
 * contradicts the durability clause of the KV backend contract.
 */
export type JournalMode = 'wal' | 'delete' | 'truncate' | 'persist'

/* jscpd:ignore-start -- deliberately mirrors the session-persistence-sqlite /
   session-query-sqlite open sequence; this group is the third user, and the
   shared medium helper is deferred to the log-facet migration so the session
   packages stay untouched this phase (see the domain KV storage design record's
   reuse audit). */
/**
 * 以仅所有者可访问的权限独占创建缺失的数据库文件；既有文件交由打开前校验。
 * `DatabaseSync` 随后按路径重新打开，父目录允许其他用户替换目录项时仍有竞态。
 */
async function createDatabaseFile(path: string): Promise<void> {
  try {
    const handle = await open(path, 'wx', 0o600)
    await handle.close()
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
  }
}

/**
 * POSIX 上拒绝软链接、非普通文件、非当前用户持有或允许群组／其他用户访问的数据库路径。
 * Windows 不提供 POSIX 权限位保证，文件隐私取决于继承的 ACL。
 * @param path - 已存在或刚创建的数据库路径。
 */
async function validateDatabaseFile(path: string): Promise<void> {
  if (process.platform === 'win32') return
  const file = await lstat(path)
  if (file.isSymbolicLink()) {
    throw new StorageError('malformed-medium', `storage database at "${path}" is a symbolic link; use a private regular file`)
  }
  if (!file.isFile()) {
    throw new StorageError('malformed-medium', `storage database at "${path}" is not a regular file; use a private regular file`)
  }
  const uid = process.getuid?.()
  if (uid !== undefined && file.uid !== uid) {
    throw new StorageError('malformed-medium', `storage database at "${path}" is not owned by the current user; use a file owned by this user`)
  }
  if ((file.mode & 0o077) !== 0) {
    throw new StorageError('malformed-medium', `storage database at "${path}" permits group or other access; restrict it to owner-only permissions (chmod 600)`)
  }
}

/**
 * 打开数据库，配置 schema 和 pragma。缺失目录和文件以仅所有者可访问的权限创建；
 * POSIX 上打开前校验文件类型、所有权与权限（`:memory:` 跳过文件系统准备）。
 * 零 `user_version` 会标记为 {@link STORAGE_SQLITE_SCHEMA_VERSION}，其他非当前版本拒绝迁移。
 * @param path - SQLite 数据库文件路径，或 `:memory:`。
 * @param journalMode - 已校验的 journal pragma。
 * @returns 已配置 pragma 且建好单元元数据表的连接。
 */
export async function openDatabase(path: string, journalMode: JournalMode): Promise<DatabaseSync> {
  const actual = path === ':memory:' ? path : resolve(path)
  if (actual !== ':memory:') {
    await mkdir(dirname(actual), { recursive: true, mode: 0o700 })
    await createDatabaseFile(actual)
    await validateDatabaseFile(actual)
  }
  const db = new DatabaseSync(actual)
  try {
    configureDatabase(db, actual, journalMode)
    return db
  } catch (error: unknown) {
    db.close()
    throw error
  }
}

function configureDatabase(db: DatabaseSync, path: string, journalMode: JournalMode): void {
  db.exec('PRAGMA foreign_keys = ON')
  // The validated union is safe to interpolate into a non-bindable PRAGMA.
  db.exec(`PRAGMA journal_mode = ${journalMode.toUpperCase()}`)
  // `PRAGMA user_version` always returns exactly one row { user_version }.
  const { user_version: onDisk } = db.prepare('PRAGMA user_version').get() as { user_version: number }
  if (onDisk !== 0 && onDisk !== STORAGE_SQLITE_SCHEMA_VERSION) {
    throw new StorageError(
      'version-mismatch',
      `storage database at "${path}" has schema version ${onDisk}, incompatible with this build (${STORAGE_SQLITE_SCHEMA_VERSION})`,
    )
  }
  /* jscpd:ignore-end */
  db.exec(`
    CREATE TABLE IF NOT EXISTS units (
      name    TEXT PRIMARY KEY,
      version INTEGER NOT NULL
    ) STRICT
  `)
  db.exec(`
    CREATE TABLE IF NOT EXISTS unit_globals (
      unit  TEXT PRIMARY KEY REFERENCES units(name),
      value TEXT NOT NULL
    ) STRICT
  `)
  if (onDisk === 0) {
    // Stamp fresh databases LAST: the stamp asserts the layout is complete,
    // so a failure above must leave the medium unstamped (a re-open after
    // the obstruction is cleared retries materialization from scratch).
    db.exec(`PRAGMA user_version = ${STORAGE_SQLITE_SCHEMA_VERSION}`)
  }
}

/**
 * Physical table name for one unit table. Both segments are validated against
 * `UNIT_NAME_RE` before reaching this, so the result is safe to interpolate
 * into DDL and prepared-statement text.
 * @param unit - Validated unit name.
 * @param table - Validated table name.
 * @returns the `u_<unit>_<table>` identifier.
 */
export function recordTableName(unit: string, table: string): string {
  return `u_${unit}_${table}`
}
