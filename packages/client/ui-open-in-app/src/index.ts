/**
 * 工作区打开浏览器插件的 Node 半边。空 apply 使插件出现在 Host Loader 中；
 * 浏览器行为由 `./client` 提供，Host 路由由 `@deepseek-ai/dsh-host-open-in-app` 拥有。
 */

/** 空 Node 插件；本包的行为全部位于浏览器半边。 */
export function apply(): void {}
