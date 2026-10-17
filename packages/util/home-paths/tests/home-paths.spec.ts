import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  CODING_HOME_DIR_NAME,
  DEFAULT_CODING_HOME_DISPLAY,
  LEGACY_DSH_HOME_DIR_NAME,
  LEGACY_DSH_HOME_DISPLAY,
  MIGRATION_MARKER_FILE,
  canonicalizeWatchPath,
  defaultCodingHome,
  dshHomeDisplay,
  dshHomePath,
  expandHomePath,
  isHomeDisplayPath,
  legacyDshHome,
  migrateCodingHome,
  resolveDshHome,
} from '@deepseek-ai/dsh-home-paths'

const cleanups: string[] = []

afterEach(async () => {
  vi.unstubAllEnvs()
  await Promise.all(cleanups.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

/** A throwaway operating-system home used to probe default and legacy data homes. */
async function tempHome(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), 'coding-home-'))
  cleanups.push(home)
  return home
}

/** Populate a legacy home so the resolver and migration treat it as real user data. */
async function seedLegacyHome(home: string): Promise<void> {
  await mkdir(join(home, LEGACY_DSH_HOME_DIR_NAME, 'sessions'), { recursive: true })
  await writeFile(join(home, LEGACY_DSH_HOME_DIR_NAME, 'settings.yaml'), 'a')
  await writeFile(join(home, LEGACY_DSH_HOME_DIR_NAME, 'sessions', 'one.jsonl'), 'bb')
}

describe('home path helpers', () => {
  it('owns the shared default Coding home directory name', () => {
    expect(CODING_HOME_DIR_NAME).toBe('.coding')
    expect(DEFAULT_CODING_HOME_DISPLAY).toBe('~/.coding')
    expect(LEGACY_DSH_HOME_DISPLAY).toBe('~/.dsh')
    expect(defaultCodingHome('/home/user')).toBe('/home/user/.coding')
    expect(legacyDshHome('/home/user')).toBe('/home/user/.dsh')
  })

  it('expands tilde paths without changing non-tilde paths', () => {
    expect(expandHomePath('~')).toBe(homedir())
    expect(expandHomePath('~/.coding')).toBe(join(homedir(), '.coding'))
    expect(expandHomePath('~\\.coding')).toBe(join(homedir(), '.coding'))
    expect(expandHomePath('/tmp/.coding')).toBe('/tmp/.coding')
    expect(expandHomePath('~other/.coding')).toBe('~other/.coding')
  })

  it('resolves explicit path before CODING_HOME, DSH_HOME, and the default', async () => {
    const home = await tempHome()
    const envHome = join(homedir(), 'env-coding')

    expect(resolveDshHome('/tmp/explicit-coding', { CODING_HOME: '~/env-coding' }, home)).toBe(resolve('/tmp/explicit-coding'))
    expect(resolveDshHome(undefined, { CODING_HOME: '~/env-coding', DSH_HOME: '~/env-dsh' }, home)).toBe(envHome)
    expect(resolveDshHome(undefined, { DSH_HOME: '~/env-dsh' }, home)).toBe(join(homedir(), 'env-dsh'))
    expect(resolveDshHome(undefined, {}, home)).toBe(join(home, CODING_HOME_DIR_NAME))
  })

  it('prefers a populated Coding home and falls back to a populated legacy home', async () => {
    const home = await tempHome()
    await seedLegacyHome(home)

    expect(resolveDshHome(undefined, {}, home)).toBe(join(home, LEGACY_DSH_HOME_DIR_NAME))

    await mkdir(join(home, CODING_HOME_DIR_NAME), { recursive: true })
    await writeFile(join(home, CODING_HOME_DIR_NAME, 'settings.yaml'), 'c')

    expect(resolveDshHome(undefined, {}, home)).toBe(join(home, CODING_HOME_DIR_NAME))
  })

  it('ignores an empty Coding home so a populated legacy home still wins', async () => {
    const home = await tempHome()
    await seedLegacyHome(home)
    await mkdir(join(home, CODING_HOME_DIR_NAME), { recursive: true })

    expect(resolveDshHome(undefined, {}, home)).toBe(join(home, LEGACY_DSH_HOME_DIR_NAME))
  })

  it('treats an empty or whitespace-only home variable as unset', async () => {
    const home = await tempHome()
    await seedLegacyHome(home)

    expect(resolveDshHome(undefined, { CODING_HOME: '' }, home)).toBe(join(home, LEGACY_DSH_HOME_DIR_NAME))
    expect(resolveDshHome(undefined, { CODING_HOME: '   ', DSH_HOME: '  ' }, home)).toBe(join(home, LEGACY_DSH_HOME_DIR_NAME))
  })

  it('joins child segments onto the resolved home', () => {
    vi.stubEnv('CODING_HOME', '~/env-coding')
    expect(dshHomePath()).toBe(join(homedir(), 'env-coding'))
    expect(dshHomePath('memory', 'notes.md')).toBe(join(homedir(), 'env-coding', 'memory', 'notes.md'))
  })

  it('labels a resolved home by default, legacy, or defining variable', () => {
    expect(dshHomeDisplay(resolve(defaultCodingHome()), {})).toBe('~/.coding')
    expect(dshHomeDisplay(resolve(legacyDshHome()), {})).toBe('~/.dsh')
    expect(dshHomeDisplay('/some/other/root', { CODING_HOME: '/some/other/root' })).toBe('$CODING_HOME')
    expect(dshHomeDisplay('/some/other/root', { DSH_HOME: '/some/other/root' })).toBe('$DSH_HOME')
    expect(dshHomeDisplay('/some/other/root', {})).toBe('$CODING_HOME')
  })

  it('recognizes every home display spelling as a home path', () => {
    expect(isHomeDisplayPath('~/.coding/AGENTS.md')).toBe(true)
    expect(isHomeDisplayPath('~/.dsh/AGENTS.md')).toBe(true)
    expect(isHomeDisplayPath('$CODING_HOME/AGENTS.md')).toBe(true)
    expect(isHomeDisplayPath('$DSH_HOME/AGENTS.md')).toBe(true)
    expect(isHomeDisplayPath('AGENTS.md')).toBe(false)
    expect(isHomeDisplayPath(join('packages', 'app', 'AGENTS.md'))).toBe(false)
  })

  it('canonicalizes a watcher ancestor while preserving a missing suffix', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-watch-path-'))
    cleanups.push(root)
    const target = join(root, 'target')
    const alias = join(root, 'alias')
    await mkdir(target)
    await symlink(target, alias, process.platform === 'win32' ? 'junction' : 'dir')
    await expect(canonicalizeWatchPath(join(alias, 'later', 'config.yml'))).resolves.toBe(
      join(await realpath(target), 'later', 'config.yml'),
    )
    const file = join(root, 'file')
    await writeFile(file, 'not a directory')
    await expect(canonicalizeWatchPath(join(file, 'child'))).rejects.toMatchObject({ code: 'ENOTDIR' })
  })
})

describe('first-start home migration', () => {
  it('copies a populated legacy home into ~/.coding and keeps the source', async () => {
    const home = await tempHome()
    await seedLegacyHome(home)

    const migration = await migrateCodingHome({ homeDir: home, env: {} })

    expect(migration).toMatchObject({
      status: 'migrated',
      home: join(home, CODING_HOME_DIR_NAME),
      legacyHome: join(home, LEGACY_DSH_HOME_DIR_NAME),
      entries: 3,
      bytes: 3,
    })
    await expect(readFile(join(home, CODING_HOME_DIR_NAME, 'settings.yaml'), 'utf8')).resolves.toBe('a')
    await expect(readFile(join(home, CODING_HOME_DIR_NAME, 'sessions', 'one.jsonl'), 'utf8')).resolves.toBe('bb')
    await expect(readFile(join(home, LEGACY_DSH_HOME_DIR_NAME, 'settings.yaml'), 'utf8')).resolves.toBe('a')
    const marker = JSON.parse(await readFile(join(home, CODING_HOME_DIR_NAME, MIGRATION_MARKER_FILE), 'utf8')) as {
      migratedFrom: string
      entries: number
      bytes: number
    }
    expect(marker).toMatchObject({ migratedFrom: join(home, LEGACY_DSH_HOME_DIR_NAME), entries: 3, bytes: 3 })
    expect(resolveDshHome(undefined, {}, home)).toBe(join(home, CODING_HOME_DIR_NAME))
  })

  it('runs at most once, leaving an already-migrated Coding home alone', async () => {
    const home = await tempHome()
    await seedLegacyHome(home)
    await migrateCodingHome({ homeDir: home, env: {} })

    await expect(migrateCodingHome({ homeDir: home, env: {} })).resolves.toMatchObject({ status: 'not-needed' })
  })

  it('leaves an explicitly configured home untouched', async () => {
    const home = await tempHome()
    await seedLegacyHome(home)

    const migration = await migrateCodingHome({ homeDir: home, env: { CODING_HOME: '/elsewhere' } })

    expect(migration.status).toBe('explicit-home')
    expect(resolveDshHome(undefined, { CODING_HOME: '/elsewhere' }, home)).toBe(resolve('/elsewhere'))
    await expect(readFile(join(home, CODING_HOME_DIR_NAME, 'settings.yaml'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('does nothing when the legacy home holds no data', async () => {
    const home = await tempHome()

    await expect(migrateCodingHome({ homeDir: home, env: {} })).resolves.toMatchObject({ status: 'not-needed' })
  })

  it('migrates a home with many small runtime entries without an entry-count cutoff', async () => {
    const home = await tempHome()
    await mkdir(join(home, LEGACY_DSH_HOME_DIR_NAME, 'runtime'), { recursive: true })
    await writeFile(join(home, LEGACY_DSH_HOME_DIR_NAME, 'settings.yaml'), 'a')
    for (let index = 0; index < 500; index++) {
      await writeFile(join(home, LEGACY_DSH_HOME_DIR_NAME, 'runtime', `entry-${index}`), 'x')
    }

    await expect(migrateCodingHome({ homeDir: home, env: {} })).resolves.toMatchObject({
      status: 'migrated',
      home: join(home, CODING_HOME_DIR_NAME),
      entries: 502,
      bytes: 501,
    })
    await expect(readFile(join(home, CODING_HOME_DIR_NAME, 'settings.yaml'), 'utf8')).resolves.toBe('a')
  }, 60_000)

  it('leaves an oversized legacy home for a manual migration', async () => {
    const home = await tempHome()
    await seedLegacyHome(home)

    const migration = await migrateCodingHome({ homeDir: home, env: {}, maxBytes: 1 })

    expect(migration).toMatchObject({ status: 'too-large', home: join(home, LEGACY_DSH_HOME_DIR_NAME), bytes: 3 })
    expect(resolveDshHome(undefined, {}, home)).toBe(join(home, LEGACY_DSH_HOME_DIR_NAME))
  })

  it('falls back to the legacy home when the Coding home path is unusable', async () => {
    const home = await tempHome()
    await seedLegacyHome(home)
    await writeFile(join(home, CODING_HOME_DIR_NAME), 'not a directory')

    const migration = await migrateCodingHome({ homeDir: home, env: {} })

    expect(migration).toMatchObject({ status: 'failed', home: join(home, LEGACY_DSH_HOME_DIR_NAME) })
    expect(resolveDshHome(undefined, {}, home)).toBe(join(home, LEGACY_DSH_HOME_DIR_NAME))
  })
})
