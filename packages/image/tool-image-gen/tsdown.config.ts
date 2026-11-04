import { defineConfig } from 'tsdown'

/** Host 模型工具及包级不变量的独立入口。 */
export default defineConfig([{
  entry: ['lib/types/index.js', 'lib/types/invariant.js'],
  outDir: 'lib', format: ['esm'], platform: 'node', target: 'es2024',
  fixedExtension: false, dts: false, clean: false,
}])
