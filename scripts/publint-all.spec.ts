import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { afterEach, describe, expect, it } from 'vitest'

const repositoryRoot = fileURLToPath(new URL('..', import.meta.url))
const runner = fileURLToPath(new URL('./publint-all.ts', import.meta.url))
const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function fixture(options: {
  packagePath?: string
  name?: string
  exportPath?: string
  extraExports?: Record<string, string>
  indexSource?: string
  files?: Record<string, string>
} = {}): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-publint-all-'))
  roots.push(root)
  addPackage(root, options)
  return root
}

function addPackage(root: string, options: {
  packagePath?: string
  name?: string
  exportPath?: string
  extraExports?: Record<string, string>
  indexSource?: string
  files?: Record<string, string>
} = {}): void {
  const packageDir = join(root, options.packagePath ?? 'packages/core/probe')
  mkdirSync(join(packageDir, 'lib'), { recursive: true })
  writeFileSync(join(packageDir, 'package.json'), `${JSON.stringify({
    name: options.name ?? 'coding-probe',
    version: '0.0.1',
    type: 'module',
    license: 'MIT',
    engines: { node: '>=22.19' },
    sideEffects: false,
    files: ['lib'],
    exports: {
      '.': { default: options.exportPath ?? './lib/index.js' },
      ...options.extraExports,
    },
  }, null, 2)}\n`)
  writeFileSync(join(packageDir, 'README.md'), '# Probe\n')
  writeFileSync(join(packageDir, 'lib/index.js'), options.indexSource ?? 'export const probe = true\n')
  for (const [path, source] of Object.entries(options.files ?? {})) {
    mkdirSync(join(packageDir, path, '..'), { recursive: true })
    writeFileSync(join(packageDir, path), source)
  }
  writeFileSync(join(packageDir, 'unpublished.js'), 'export const hidden = true\n')
}

function run(root: string) {
  return spawnSync(process.execPath, [
    '--import', 'tsx', runner,
    '--packages-root', root,
  ], {
    cwd: repositoryRoot,
    encoding: 'utf8',
    timeout: 5_000,
  })
}

describe('publint package runner', () => {
  it('lints recursively declared files from an in-memory publication view', () => {
    const result = run(fixture())
    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toContain('linting 1 package(s)')
    expect(result.stdout).toContain('All good!')
  })

  it('rejects an export that exists in the workspace but is not published', () => {
    const result = run(fixture({ exportPath: './unpublished.js' }))
    expect(result.status).toBe(1)
    expect(result.stdout).toContain('unpublished.js')
  })

  it('rejects a public export whose built file is missing', () => {
    const result = run(fixture({ exportPath: './lib/missing.js' }))
    expect(result.status).toBe(1)
    expect(result.stdout).toContain('missing.js')
    expect(result.stderr).toContain('publint-all: failed packages (1):\n- packages/core/probe')
    expect(result.stderr).toContain('missing.js')
  })

  it('does not fail for an unpublished source wildcard warning', () => {
    const result = run(fixture({
      extraExports: { './src/*': './src/*' },
      files: { 'src/index.ts': 'export const source = true\n' },
    }))
    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toContain('./src/*')
    expect(result.stderr).not.toContain('publint-all: failed packages')
  })

  it('summarizes an early error without listing later warning and passing packages', () => {
    const root = fixture({
      packagePath: 'packages/core/early',
      name: 'coding-early',
      exportPath: './lib/missing.js',
    })
    addPackage(root, {
      packagePath: 'packages/core/later-warning',
      name: 'coding-later-warning',
      extraExports: { './src/*': './src/*' },
    })
    addPackage(root, { packagePath: 'packages/core/last-passing', name: 'coding-last-passing' })

    const result = run(root)
    expect(result.status).toBe(1)
    expect(result.stdout).toContain('Running publint for packages/core/later-warning...')
    expect(result.stdout).toContain('./src/*')
    expect(result.stdout).toContain('Running publint for packages/core/last-passing...')
    const summary = result.stderr.slice(result.stderr.lastIndexOf('publint-all: failed packages'))
    expect(summary).toContain('publint-all: failed packages (1):\n- packages/core/early')
    expect(summary).toContain('missing.js')
    expect(summary).not.toContain('packages/core/later-warning')
    expect(summary).not.toContain('packages/core/last-passing')
  })

  it('accepts published relative JavaScript and CSS targets', () => {
    const result = run(fixture({
      indexSource: "export { helper } from './helper.js'\nimport './theme.css'\n",
      files: {
        'lib/helper.js': 'export const helper = true\n',
        'lib/theme.css': ':root {}\n',
      },
    }))
    expect(result.status, result.stderr).toBe(0)
  })

  it('rejects unpublished relative JavaScript and CSS targets', () => {
    const result = run(fixture({
      indexSource: "export { helper } from './missing.js'\nimport './missing.css'\n",
    }))
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('imports "./missing.js"')
    expect(result.stderr).toContain('imports "./missing.css"')
    expect(result.stderr).toContain('publint-all: failed packages (1):\n- packages/core/probe')
  })
})
