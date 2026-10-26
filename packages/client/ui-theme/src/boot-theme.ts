/**
 * 宿主渲染的主题引导脚本，覆盖浏览器在插件树激活前的空窗期。
 *
 * 每次 index 响应都带上当前持久化的选择；脚本只解析 `system`（以及声明跟随
 * 明暗的主题），然后写入与 ui-layout 的 ThemePresenter 相同的 DOM 字段。主题
 * 预设的令牌由客户端接管，这里额外铺一层该方案的画布底色，避免首帧闪白。
 */
import { DEFAULT_PREFERENCE, isThemePreference } from './theme-settings.ts'
import { findThemePreset } from './themes/catalog.ts'

/** 引导脚本需要的明暗与画布底色。 */
interface BootTheme {
  /** 解析后的明暗；`auto` 与 `system` 都交给系统配色。 */
  scheme: 'light' | 'dark' | 'system' | 'auto'
  /** 该方案的画布底色；主题自带时用它先铺一层。 */
  background: string | undefined
}

/**
 * 把一次持久化选择解析成引导脚本要的明暗。
 * @param preference - 设置文档里的选择（内置偏好或主题预设 id）。
 * @returns 明暗与画布底色；未知 id 与 `system` 都交给系统配色。
 */
export function bootThemeOf(preference: string): BootTheme {
  if (isThemePreference(preference)) {
    const preset = preference === 'system' ? undefined : findThemePreset(preference)
    return { scheme: preference, background: preset?.preview.background }
  }
  const preset = findThemePreset(preference)
  if (preset === undefined) return { scheme: 'system', background: undefined }
  return {
    scheme: preset.scheme,
    background: preset.scheme === 'auto' ? undefined : preset.preview.background,
  }
}

/** 生成一段自包含的引导脚本（数据来自内置目录，仍按 HTML 语境转义 `<`）。 */
function bootThemeScript(theme: BootTheme): string {
  const literal = (value: string): string => JSON.stringify(value).replace(/</g, '\\u003c')
  return `<script>(() => {
  const scheme = ${literal(theme.scheme)}
  const background = ${literal(theme.background ?? '')}
  const systemDark = (scheme === 'system' || scheme === 'auto')
    && typeof matchMedia !== 'undefined'
    && matchMedia('(prefers-color-scheme: dark)').matches
  const dark = scheme === 'dark' || systemDark
  document.documentElement.style.colorScheme = dark ? 'dark' : 'light'
  document.body.toggleAttribute('data-ds-dark-theme', dark)
  if (background !== '') document.body.style.backgroundColor = background
})()</script>`
}

/**
 * 在 body 起始标签之后插入主题引导脚本，先于外壳挂载与模块脚本。没有 body
 * 的片段插在末尾——那里的解析器已经补过 body。
 * @param html - 原始应用 index HTML。
 * @param preference - 当前宿主设置里的主题选择。
 * @returns 含引导脚本的 HTML。
 */
export function injectBootTheme(
  html: string,
  preference: string = DEFAULT_PREFERENCE,
): string {
  const script = bootThemeScript(bootThemeOf(preference))
  const body = /<body(?:\s[^>]*)?>/i.exec(html)
  if (body === null) return `${html}${script}`
  const at = body.index + body[0].length
  return `${html.slice(0, at)}${script}${html.slice(at)}`
}
