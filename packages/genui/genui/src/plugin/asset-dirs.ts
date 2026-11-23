/**
 * 懒引擎资产目录解析：`lib/assets/` 的产出目录固定，但读取它的模块可能来自
 * 两个位置——构建产物 `lib/index.js`，或 `dsh web` 用 tsx 直接加载源码时的
 * `src/plugin/index.ts`。tsdown 只产出到 `lib/`，所以源码位置要回退一次。
 * @module coding-genui/plugin/asset-dirs
 */
import { fileURLToPath } from 'node:url'

/**
 * 按优先级返回资产目录候选：构建产物位置在前，源码运行位置在后。
 * @param moduleUrl - 当前模块的 `import.meta.url`。
 * @returns 以 `node:path` 语义表示的目录，调用方按顺序尝试读取。
 */
export function assetDirCandidates(moduleUrl: URL | string): string[] {
  return ['./assets/', './../../lib/assets/'].map(relative => fileURLToPath(new URL(relative, moduleUrl)))
}
