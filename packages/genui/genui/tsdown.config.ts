/**
 * GenUI tsdown：Node 半（宿主插件）+ 浏览器 client bundle（dsh-ui 渲染器）
 * + 懒引擎资产（mermaid/three/echarts 的按需 IIFE）。client 侧走共享
 * clientBundle preset；懒引擎资产是本包专有的多入口 IIFE 构型，由
 * companions 挂进同一构建。
 */
import type { UserConfig } from 'tsdown'
import { clientBundle } from '../../client/tsdown.client.ts'

const ID = 'coding-genui'

/** 懒引擎资产：单入口 IIFE，运行时经宿主半的资产路由按需注入。 */
function assetConfig(name: 'mermaid' | 'three' | 'echarts-core' | 'echarts-full', entry: string): UserConfig {
  return {
    name: `${ID}/assets/${name}`,
    entry: { [`assets/${name}`]: entry },
    outDir: 'lib',
    format: 'iife',
    platform: 'browser',
    dts: false,
    minify: true,
    sourcemap: false,
    clean: false,
    deps: { alwaysBundle: () => true },
    define: {
      'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'production'),
    },
    outputOptions: { entryFileNames: '[name].js' },
  }
}

export default clientBundle(ID, ['lib/types/index.js', 'lib/types/invariant.js'], {
  companions: [
    assetConfig('mermaid', 'src/client/asset-mermaid.ts'),
    assetConfig('three', 'src/client/asset-three.ts'),
    assetConfig('echarts-core', 'src/client/asset-echarts-core.ts'),
    assetConfig('echarts-full', 'src/client/asset-echarts.ts'),
  ],
})
