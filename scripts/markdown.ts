/**
 * 生成器共用的标题锚点算法。
 *
 * 历史上下文：本模块曾承载文档门禁共用的 Markdown 解析与遍历；门禁删除后只剩
 * `githubSlug`，它在 `gen-config-catalog`、`gen-persistence-catalog` 与
 * `gen-tool-catalog` 里为生成的目录条目生成锚点。
 */

/**
 * GitHub 的标题锚点算法：转小写，去掉字母、数字、下划线、空格和连字符以外的字符，空格换成连字符。
 * 下划线保留（`## Showcase: web_fetch` → `#showcase-web_fetch`）。
 * @param heading - 已渲染的标题文本，Markdown 语法此时已去除。
 * @returns GitHub 为同名标题第一次出现分配的锚点。
 */
export function githubSlug(heading: string): string {
  return heading.toLowerCase().replace(/[^\p{L}\p{N}_ -]/gu, '').replaceAll(' ', '-')
}
