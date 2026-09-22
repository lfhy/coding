/** Cordis Loader configuration file discovery. */

import { globSync } from 'node:fs'

/**
 * 返回 `root` 下仓库相对的 Cordis Loader YAML 路径。
 * @param root 要扫描的仓库根目录。
 * @returns 排序后的仓库相对 Loader 配置文件路径。
 */
export function cordisConfigFiles(root: string): string[] {
  return globSync(['**/*cordis*.yml', '**/*cordis*.yaml'], {
    cwd: root,
    exclude: ['.claude/**', 'node_modules/**', 'vendor/**'],
  }).sort()
}
