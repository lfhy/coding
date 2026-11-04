import { defineConfig } from 'tsdown'

/** Host 服务的公开入口和包级不变量伴随入口。 */
export default defineConfig([{
  entry: ['lib/types/index.js', 'lib/types/invariant.js'],
  outDir: 'lib', format: ['esm'], platform: 'node', target: 'es2024',
  fixedExtension: false, dts: false, clean: false,
}])
