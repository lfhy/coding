/** Experimental-package publication and dependency constraints. */

import { describe, expect, it } from 'vitest'
import {
  checkExperimentalDependencyIsolation,
  checkExperimentalManifest,
  checkPrivateElectronShellManifest,
  type WorkspaceManifest,
} from './check-workspace-constraints.ts'

const experimental: WorkspaceManifest = {
  dir: 'packages/experimental/prototype',
  manifest: { name: 'coding-experimental-prototype', private: true },
}

describe('experimental workspace constraints', () => {
  it('requires the experimental package-name prefix', () => {
    expect(checkExperimentalManifest({
      ...experimental,
      manifest: { ...experimental.manifest, name: 'coding-prototype' },
    })).toEqual([
      'coding-prototype: experimental package name must start with "coding-experimental-"',
    ])
  })

  it('requires private manifests without publication metadata', () => {
    expect(checkExperimentalManifest(experimental)).toEqual([])
    expect(checkExperimentalManifest({
      ...experimental,
      manifest: { ...experimental.manifest, private: false, publishConfig: { access: 'public' } },
    })).toEqual([
      'coding-experimental-prototype: experimental package must set "private": true',
      'coding-experimental-prototype: experimental package must omit publishConfig',
    ])
  })

  it.each(['dependencies', 'optionalDependencies', 'peerDependencies'] as const)(
    'rejects release %s on an experimental package',
    (section) => {
      expect(checkExperimentalDependencyIsolation([experimental, {
        dir: 'packages/core/consumer',
        manifest: {
          name: 'coding-consumer',
          [section]: { 'coding-experimental-prototype': 'workspace:^' },
        },
      }])).toEqual([
        `coding-consumer: ${section}.coding-experimental-prototype must not reference an experimental package`,
      ])
    },
  )

  it('allows development and experimental consumers but rejects the Python release runtime', () => {
    const manifests: WorkspaceManifest[] = [experimental, {
      dir: 'packages/core/test-only',
      manifest: {
        name: 'coding-test-only',
        devDependencies: { 'coding-experimental-prototype': 'workspace:^' },
      },
    }, {
      dir: 'packages/experimental/consumer',
      manifest: {
        name: 'coding-experimental-consumer',
        dependencies: { 'coding-experimental-prototype': 'workspace:^' },
      },
    }, {
      dir: 'python/sdk-runtime',
      manifest: {
        name: 'coding-python-runtime',
        dependencies: { 'coding-experimental-prototype': 'workspace:^' },
      },
    }]

    expect(checkExperimentalDependencyIsolation(manifests)).toEqual([
      'coding-python-runtime: dependencies.coding-experimental-prototype must not reference an experimental package',
    ])
  })
})

describe('private Electron workspace constraints', () => {
  const shell: WorkspaceManifest = {
    dir: 'apps/desktop-electron',
    manifest: { name: 'coding-desktop-electron', private: true },
  }

  it('requires the expected identity and excludes publication metadata', () => {
    expect(checkPrivateElectronShellManifest(shell)).toEqual([])
    expect(checkPrivateElectronShellManifest({
      ...shell,
      manifest: { name: '@deepseek-ai/unrelated', private: false, publishConfig: { access: 'public' } },
    })).toEqual([
      '@deepseek-ai/unrelated: Electron shell must use coding-desktop-electron',
      '@deepseek-ai/unrelated: Electron shell must set "private": true',
      '@deepseek-ai/unrelated: Electron shell must omit publishConfig',
    ])
  })

  it('does not apply the shell policy to publishable apps', () => {
    expect(checkPrivateElectronShellManifest({ ...shell, dir: 'apps/cli' })).toEqual([])
  })
})
