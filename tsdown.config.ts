import { defineConfig } from 'tsdown'
import { typertPlugin } from './packages/typert/generator/lib/types/tsdown-plugin.js'
import { llmBuildIdentity } from './scripts/llm-build-identity.ts'

function isBuildFaceClient(value: unknown): boolean {
  if (value === undefined || value === 'host') return false
  if (value === 'client') return true
  throw new Error(`tsdown: --env.DSH_BUILD_FACE must be host or client, received ${String(value)}`)
}

/**
 * Host/Client 工作区构建配置；Host 将一次构建的公开日期和修订号内联进模型 UA。
 * @module tsdown-config
 */
export default defineConfig(({ env }) => {
  const client = isBuildFaceClient(env?.DSH_BUILD_FACE)
  const identity = client ? undefined : llmBuildIdentity(import.meta.dirname)
  return {
    workspace: ['vendor/*', 'packages/*/*', 'apps/cli'],
    entry: client ? '' : ['lib/types/{index,invariant,startup,bin}.js'],
    outDir: 'lib',
    format: ['esm'],
    platform: 'node',
    target: 'es2024',
    fixedExtension: false,
    dts: false,
    clean: false,
    // 仅将公开的构建事实内联到 Host；本地源码测试仍可独立运行。
    ...identity === undefined ? {} : { define: {
      'process.env.DSH_LLM_BUILD_DATE': JSON.stringify(identity.date),
      'process.env.DSH_LLM_BUILD_COMMIT': JSON.stringify(identity.commit),
    } },
    plugins: client ? [] : [typertPlugin({ mode: 'workspace', faces: ['host'] })],
  }
})
