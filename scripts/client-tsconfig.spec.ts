/** Regression coverage for source declarations owned by the client test aggregate. */

import { existsSync, readdirSync } from 'node:fs'
import { dirname, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'

const root = fileURLToPath(new URL('..', import.meta.url))

function clientCssDeclarations(): string[] {
  const clientGroups = ['client', 'extensions', 'genui']
  return clientGroups.flatMap((group) => {
    const clientRoot = resolve(root, 'packages', group)
    return readdirSync(clientRoot, { withFileTypes: true })
      .filter(entry => entry.isDirectory())
      .map(entry => resolve(clientRoot, entry.name, 'src/css-modules.d.ts'))
  })
    .filter(existsSync)
    .map(file => file.replaceAll(sep, '/'))
    .sort()
}

describe('client TypeScript aggregate', () => {
  it('isolates GenUI Host tests in their own project and keeps Client tests in the Client aggregate', () => {
    const readFiles = (configPath: string): string[] => {
      const read = ts.readConfigFile(configPath, file => ts.sys.readFile(file))
      if (read.error !== undefined) throw new Error(ts.flattenDiagnosticMessageText(read.error.messageText, '\n'))
      return ts.parseJsonConfigFileContent(read.config, ts.sys, dirname(configPath)).fileNames
        .map(file => file.replaceAll(sep, '/'))
    }
    const hostAggregate = readFiles(resolve(root, 'tsconfig.host.json'))
    const clientAggregate = readFiles(resolve(root, 'tsconfig.client.json'))
    const genuiHost = readFiles(resolve(root, 'packages/genui/genui/tsconfig.host.json'))
    const hostTest = resolve(root, 'packages/genui/genui/tests/fence-feedback-persistence.host.spec.ts').replaceAll(sep, '/')
    const clientTest = resolve(root, 'packages/genui/genui/tests/toolview.client.spec.tsx').replaceAll(sep, '/')

    expect(hostAggregate).not.toContain(hostTest)
    expect(clientAggregate).not.toContain(hostTest)
    expect(genuiHost).toContain(hostTest)
    expect(genuiHost).not.toContain(clientTest)
    expect(clientAggregate).toContain(clientTest)
  })

  it('loads package CSS declarations without relying on workspace-link realpaths', () => {
    const configPath = resolve(root, 'tsconfig.client.json')
    const read = ts.readConfigFile(configPath, file => ts.sys.readFile(file))
    if (read.error !== undefined) {
      throw new Error(ts.flattenDiagnosticMessageText(read.error.messageText, '\n'))
    }
    const parsed = ts.parseJsonConfigFileContent(read.config, ts.sys, root)
    const loaded = parsed.fileNames
      .map(file => file.replaceAll(sep, '/'))
      .filter(file => file.endsWith('/src/css-modules.d.ts'))
      .sort()
    expect(loaded).toEqual(clientCssDeclarations())
  })
})
