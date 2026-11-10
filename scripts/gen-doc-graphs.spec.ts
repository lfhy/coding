/**
 * Tests for the event-relation collector's demand-driven call-site indexing:
 * the single-file fast path and the global fallback must recover the same
 * helper-parameter event names, including shapes that defeat the locality
 * proof (alias escapes and global script files).
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { collectPackageSources, EventRelationCollector } from './gen-doc-graphs.ts'
import { TypeScriptProject } from './ts-project.ts'

const FIXTURE: Record<string, string> = {
  'tsconfig.host.json': JSON.stringify({
    compilerOptions: {
      target: 'es2022',
      module: 'esnext',
      moduleResolution: 'bundler',
      allowImportingTsExtensions: true,
      noEmit: true,
      skipLibCheck: true,
      types: [],
    },
    include: ['vendor/**/*.ts', 'packages/**/*.ts'],
  }),
  'vendor/cordis/src/context.ts': 'export class Context { private brand!: void }\n',
  'vendor/cordis/src/events.ts': [
    'export class EventsService {',
    '  dispatch(type: string, args: unknown[]): unknown[] { return [type, args] }',
    '}',
    '',
  ].join('\n'),
  'packages/core/agent/src/dispatch.ts':
    'export interface AgentEventDispatch { emit(...args: unknown[]): void }\n',
  // fireLocal: every same-file reference is a direct callee, so the locality
  // proof holds and only this file is indexed. fireAliased: the exported
  // const is a value-position reference, so the proof fails and the global
  // fallback must find the cross-file call in pkgb.
  'packages/fix/pkga/src/index.ts': [
    "import { EventsService } from '../../../../vendor/cordis/src/events.ts'",
    'declare const events: EventsService',
    "function fireLocal(args: [string]): void { void events.dispatch('emit', args) }",
    "fireLocal(['pkga/local-event'])",
    "function fireAliased(args: [string]): void { void events.dispatch('emit', args) }",
    'export const aliased = fireAliased',
    '',
  ].join('\n'),
  'packages/fix/pkgb/src/index.ts': [
    "import { aliased } from '../../pkga/src/index.ts'",
    "aliased(['pkgb/aliased-event'])",
    '',
  ].join('\n'),
  // Global script files (no import/export): scriptFire is program-visible, so
  // the cross-file call in caller.ts leaves no same-file reference. Only the
  // module-ness premise check routes this helper to the global index; without
  // it the proof would pass and the event would silently drop.
  'packages/fix/pkgc/src/globals.ts':
    "declare var gEvents: import('../../../../vendor/cordis/src/events.ts').EventsService\n",
  'packages/fix/pkgc/src/helper.ts':
    "function scriptFire(args: [string]): void { void gEvents.dispatch('emit', args) }\n",
  'packages/fix/pkgc/src/caller.ts': "scriptFire(['pkgc/script-event'])\n",
}

const root = mkdtempSync(join(tmpdir(), 'gen-doc-graphs-'))
for (const [rel, content] of Object.entries(FIXTURE)) {
  mkdirSync(dirname(join(root, rel)), { recursive: true })
  writeFileSync(join(root, rel), content)
}
const project = new TypeScriptProject(root)
const sources = collectPackageSources(project)

afterAll(() => {
  rmSync(root, { recursive: true, force: true })
})

function dispatchersOf(pkgs: readonly string[], event: string): string[] {
  const subset = sources.filter(source => pkgs.includes(source.pkg))
  const relations = new EventRelationCollector(project, subset).collect()
  return [...(relations.get(event)?.dispatchers.keys() ?? [])]
}

describe('event relation call-site indexing', () => {
  it('recovers a proven-local helper through the single-file fast path', () => {
    expect(dispatchersOf(['pkga', 'pkgb'], 'pkga/local-event')).toEqual(['pkga'])
  })

  it('recovers an alias-escaped helper through the global fallback', () => {
    expect(dispatchersOf(['pkga', 'pkgb'], 'pkgb/aliased-event')).toEqual(['pkga'])
  })

  it('rejects the locality proof for global script files', () => {
    // pkgc alone: the script helper is the first demand, so a wrongly passing
    // proof would index helper.ts only and lose the caller.ts call site.
    expect(dispatchersOf(['pkgc'], 'pkgc/script-event')).toEqual(['pkgc'])
  })
})

describe('browser capability diagrams', () => {
  it('shows the Host-owned default service and its model consumer alongside the optional legacy seam', () => {
    const capability = readFileSync(resolve(import.meta.dirname, '../docs/capability-seams.md'), 'utf8')
    expect(capability).toContain('pkg_browser_ego_host --> svc_egoBrowser')
    expect(capability).toContain('svc_egoBrowser --> pkg_tool_browser_ego')
    expect(capability).not.toContain('svc_egoBrowser --> pkg_ui_browser_ego')
    expect(capability).toContain('Optional legacy session browser contract')
    expect(capability).toContain('| `ctx.egoBrowser` | `core` | [`browser-ego-host`](../packages/browser/browser-ego-host) | - | [`tool-browser-ego`](../packages/browser/tool-browser-ego) | - |')
  })

  it('shows only the ego Host in the shared base composition', () => {
    const composition = readFileSync(resolve(import.meta.dirname, '../apps/cli/composition.md'), 'utf8')
    expect(composition).toContain('plugin_dsh_base_browser_ego_host["browser-ego-host<br/>coding-browser-ego-host"]')
    expect(composition).toContain('| `browser-ego-host` | `coding-browser-ego-host` |')
    expect(composition).not.toContain('browser-playwright')
    expect(composition).not.toContain('browser-electron')
    expect(composition).not.toContain('| `tool-browser` | `coding-tool-browser-ego` |')
  })

  it.each(['standard', 'longrun', 'reverse', 'webclone'])('mounts the ego browser tool in the %s session preset', (preset) => {
    const config = readFileSync(resolve(import.meta.dirname, `../apps/cli/config/agent-presets/${preset}/agent.cordis.yml`), 'utf8')
    expect(config).toMatch(/- id: tool-browser\n  name: 'coding-tool-browser-ego'/)
    expect(config).not.toContain("name: 'coding-browser-playwright'")
    expect(config).not.toContain("name: 'coding-browser-electron'")
  })
})
