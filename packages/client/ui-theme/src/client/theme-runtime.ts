/**
 * 主题运行时：`--dsw-*` 令牌之上的主题注册表与选择状态。
 *
 * 服务持有当前外观选择（`light`／`dark`／`system` 或任一已注册主题 id）、
 * 通过 `prefers-color-scheme` 解析 `system`，并发布不可变的 `ThemeSnapshot`；
 * 它绝不接触 DOM——[ui-layout] 的呈现器消费解析后的快照。
 *
 * 主题可以声明固定明暗，也可以声明 `auto` 并给出浅色/深色两套令牌：后者
 * 跟随应用外观切换，页面上的明暗开关仍然有效。选择会经设置作用域写回宿主
 * 文档，下次启动由引导脚本先按方案的底色铺一次，避免闪白。
 */
import type { Context } from '@deepseek-ai/cordis'
import type { SettingsScope } from 'coding-client-runtime/client'
import {
  DEFAULT_PREFERENCE, isThemePreference, THEME_PREFERENCE_FIELD,
  type ThemeSelection, type ThemeSettings,
} from '../theme-settings.ts'

/** 主题令牌字典：`--dsw-*` 变量名 → CSS 值。 */
export type ThemeTokens = Record<string, string>

/**
 * 覆盖层的一个 token 值：明暗两态都必须给出（同一颜色就重复写两次）。
 * 只给一侧会让用户切到另一套配色时读不清。
 */
export interface ThemeTokenModes {
  /** 浅色配色生效时的值。 */
  light: string
  /** 深色配色生效时的值。 */
  dark: string
}

/** 覆盖层字典：token 名 → 明暗值对。 */
export type ThemeTokenOverrides = Record<string, ThemeTokenModes>

/** 生效主题的明暗：`system` 与 `auto` 都已解析成具体一侧。 */
export type ThemeColorScheme = 'light' | 'dark'

/** 一个主题声明的明暗归属；`auto` 表示跟随应用外观。 */
export type ThemeSchemeDeclaration = ThemeColorScheme | 'auto'

/** 一个可注册主题：id、明暗归属与别名层令牌覆盖。 */
export interface ThemeDefinition {
  /** 主题 id（`setTheme` 的取值）。 */
  id: string
  /**
   * 固定一侧配色，或 `auto` 跟随应用外观。呈现器按解析后的 `colorScheme`
   * 切换 `body[data-ds-dark-theme]`，不从 id 推断。
   */
  colorScheme: ThemeSchemeDeclaration
  /** 固定明暗主题的别名层令牌。 */
  tokens: ThemeTokens
  /** `auto` 主题的两套令牌；`colorScheme` 为 `auto` 时必填。 */
  palettes?: { light: ThemeTokens; dark: ThemeTokens }
}

/** 解析后的生效主题：明暗已定，令牌已合入覆盖层。 */
export interface ActiveTheme {
  /** 生效主题 id（未知选择回落到基础配色时是 `light`／`dark`）。 */
  id: string
  /** 解析后的明暗。 */
  colorScheme: ThemeColorScheme
  /** 合入覆盖层后的令牌。 */
  tokens: ThemeTokens
}

/** 每次变化发布的不可变主题状态。 */
export interface ThemeSnapshot {
  /** 持久化的选择（可能是 `system`，也可能是某个已注册主题 id）。 */
  preference: ThemeSelection
  /** 当前生效的主题。 */
  active: ActiveTheme
  /** 已注册主题，按注册顺序。 */
  themes: readonly ThemeDefinition[]
  /** 单调递增的变化序号。 */
  revision: number
}

/** 暴露给 Cordis 检查的一个主题 token。 */
export interface ThemeTokenInspection {
  /** `overrideTokens` 接受的 token 名。 */
  name: string
  /** 视觉用途。 */
  description: string
  /** CSS 值类别。 */
  valueType: string
  /** 覆盖层是否必须同时给出明暗两态。 */
  requiresLightAndDark: boolean
  /** 被界面样式消费的 CSS 自定义属性。 */
  cssVariable?: string
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    theme: ThemeRuntime
  }
  interface Events {
    /**
     * 主题状态变化（切换选择、注册表变化，或偏好为 `system`／`auto` 主题时
     * 操作系统配色切换）。
     * @param snapshot - 当前的不可变主题快照。
     * @mode emit
     */
    'theme/change'(snapshot: ThemeSnapshot): void
  }
}

const BUILTIN_THEMES: readonly ThemeDefinition[] = Object.freeze([
  Object.freeze({ id: 'light', colorScheme: 'light' as const, tokens: Object.freeze({}) }),
  Object.freeze({ id: 'dark', colorScheme: 'dark' as const, tokens: Object.freeze({}) }),
])

/** 内置 token 目录：第三方覆盖层可用的取值清单。 */
const BUILTIN_INSPECT_TOKENS: readonly ThemeTokenInspection[] = Object.freeze([
  { name: '--dsw-alias-bg-base', description: '应用画布底色。', valueType: 'CSS color', requiresLightAndDark: true, cssVariable: '--dsw-alias-bg-base' },
  { name: '--dsw-alias-bg-layer-1', description: '一级抬升表面底色。', valueType: 'CSS color', requiresLightAndDark: true, cssVariable: '--dsw-alias-bg-layer-1' },
  { name: '--dsw-alias-bg-layer-2', description: '二级嵌套表面底色。', valueType: 'CSS color', requiresLightAndDark: true, cssVariable: '--dsw-alias-bg-layer-2' },
  { name: '--dsw-alias-bg-overlay', description: '浮层与弹层底色。', valueType: 'CSS color', requiresLightAndDark: true, cssVariable: '--dsw-alias-bg-overlay' },
  { name: '--dsw-alias-border-l1', description: '一级细分隔线。', valueType: 'CSS color', requiresLightAndDark: true, cssVariable: '--dsw-alias-border-l1' },
  { name: '--dsw-alias-border-l2', description: '二级描边。', valueType: 'CSS color', requiresLightAndDark: true, cssVariable: '--dsw-alias-border-l2' },
  { name: '--dsw-alias-brand-primary', description: '品牌强调色。', valueType: 'CSS color', requiresLightAndDark: true, cssVariable: '--dsw-alias-brand-primary' },
  { name: '--dsw-alias-label-primary', description: '正文色。', valueType: 'CSS color', requiresLightAndDark: true, cssVariable: '--dsw-alias-label-primary' },
  { name: '--dsw-alias-label-secondary', description: '次级文字色。', valueType: 'CSS color', requiresLightAndDark: true, cssVariable: '--dsw-alias-label-secondary' },
  { name: '--dsw-alias-state-error-primary', description: '错误态主色。', valueType: 'CSS color', requiresLightAndDark: true, cssVariable: '--dsw-alias-state-error-primary' },
  { name: '--dsw-alias-state-success-primary', description: '成功态主色。', valueType: 'CSS color', requiresLightAndDark: true, cssVariable: '--dsw-alias-state-success-primary' },
  { name: '--dsw-alias-state-warn-primary', description: '警告态主色。', valueType: 'CSS color', requiresLightAndDark: true, cssVariable: '--dsw-alias-state-warn-primary' },
  { name: '--dsw-specific-sidebar-fill', description: '侧栏整列与标题行底色。', valueType: 'CSS color', requiresLightAndDark: true, cssVariable: '--dsw-specific-sidebar-fill' },
])

/**
 * 主题注册表与选择状态的所有者。`light`／`dark` 是内置的（基础样式表
 * 带着两套配色）；产品内置预设与第三方主题都经 {@link register} 进入注册表。
 * 读走 {@link getTheme}，选择只经 {@link setTheme}，连续同步只订阅
 * `theme/change`；{@link overrideTokens} 在生效主题之上叠加局部的令牌层，
 * 不动注册表。
 * 服务持有 `prefers-color-scheme` 媒体查询（环境探测，不是呈现），偏好为
 * `system` 或主题声明 `auto` 时，系统配色翻转会重新发布。
 */
export class ThemeRuntime {
  private readonly ctx: Context
  private readonly host: SettingsScope<ThemeSettings>
  private themes: ThemeDefinition[] = [...BUILTIN_THEMES]
  private preference: ThemeSelection
  private revision = 0
  private snapshot: ThemeSnapshot
  private readonly media: MediaQueryList | undefined
  /** 覆盖层按来源存放；seq（单调递增）是叠放顺序。 */
  private readonly overrides = new Map<string, { seq: number; tokens: ThemeTokenOverrides }>()
  private overrideSeq = 0

  /**
   * @param ctx - 所属上下文（变化事件在它上面发出；媒体查询与设置订阅在
   * dispose 时经 ctx.effect 释放）。
   * @param host - 同一插件拥有的持久选择作用域。
   */
  constructor(ctx: Context, host: SettingsScope<ThemeSettings>) {
    this.ctx = ctx
    this.host = host
    this.preference = DEFAULT_PREFERENCE
    // 非浏览器运行（node e2e 启动客户端插件树）没有 matchMedia。
    this.media = typeof matchMedia === 'undefined' ? undefined : matchMedia('(prefers-color-scheme: dark)')
    this.snapshot = this.buildSnapshot()
    if (this.media !== undefined) {
      const media = this.media
      const onChange = (): void => {
        if (!this.followsColorScheme()) return
        this.publish()
      }
      ctx.effect(() => {
        media.addEventListener('change', onChange)
        return () => { media.removeEventListener('change', onChange) }
      }, 'ui-theme: prefers-color-scheme listener')
    }
    ctx.effect(() => host.subscribe(() => { this.adopt() }), 'ui-theme: settings scope adoption')
    this.adopt()
  }

  /**
   * 读取当前的不可变主题快照。
   * @returns 当前快照（引用在下次变化前保持不变）。
   */
  getTheme(): ThemeSnapshot {
    return this.snapshot
  }

  /**
   * 导出 token 目录，不读 DOM 或计算样式。
   * @returns 稳定的 JSON 安全描述，含注册主题与覆盖层引入的 token 名。
   */
  exportInspectTokens(): ThemeTokenInspection[] {
    const tokens = new Map(BUILTIN_INSPECT_TOKENS.map(token => [token.name, token]))
    const add = (name: string): void => {
      if (tokens.has(name)) return
      tokens.set(name, dynamicToken(name))
    }
    for (const theme of this.themes) {
      for (const name of Object.keys(theme.tokens)) add(name)
      if (theme.palettes !== undefined) {
        for (const name of Object.keys(theme.palettes.dark)) add(name)
        for (const name of Object.keys(theme.palettes.light)) add(name)
      }
    }
    for (const layer of this.overrides.values()) {
      for (const name of Object.keys(layer.tokens)) add(name)
    }
    return [...tokens.values()]
      .map(token => ({ ...token }))
      .sort((left, right) => left.name.localeCompare(right.name))
  }

  /**
   * 切换主题——唯一的用户选择写入入口。内置偏好与已注册主题都会被写进
   * 设置文档，因此下次启动仍是这套外观；`system` 与声明 `auto` 的主题会
   * 继续跟随系统配色。
   * @param id - 已注册主题 id 或 `system`；未知 id 抛错。
   */
  setTheme(id: string): void {
    if (id !== 'system' && !this.themes.some(t => t.id === id)) {
      throw new Error(`theme "${id}" is not registered`)
    }
    if (this.preference === id) return
    this.preference = id
    void this.host.set(THEME_PREFERENCE_FIELD, id)
    this.publish()
  }

  /**
   * 注册一个主题。id 重复会抛错（一个 id 只允许一个占用者；内置两项也计入；
   * `system` 是偏好而不是可注册 id）。
   * @param definition - 主题 id、明暗归属与别名令牌；声明 `auto` 必须带两套令牌。
   * @returns disposer。卸载正在生效的主题时，选择复位到默认值，界面不会继续
   * 使用一个已不存在的主题的令牌。
   */
  register(definition: ThemeDefinition): () => void {
    if (definition.id === 'system') throw new Error('"system" is a preference, not a registrable theme id')
    if (definition.colorScheme === 'auto' && definition.palettes === undefined) {
      throw new Error(`theme "${definition.id}" declares colorScheme "auto" without palettes`)
    }
    if (this.themes.some(t => t.id === definition.id)) {
      throw new Error(`theme "${definition.id}" is already registered`)
    }
    this.themes = [...this.themes, definition]
    this.publish()
    return () => {
      if (!this.themes.some(t => t.id === definition.id)) return
      this.themes = this.themes.filter(t => t.id !== definition.id)
      if (this.preference === definition.id) {
        this.preference = DEFAULT_PREFERENCE
        void this.host.set(THEME_PREFERENCE_FIELD, DEFAULT_PREFERENCE)
      }
      this.publish()
    }
  }

  /**
   * 在生效主题之上叠一层令牌覆盖——令牌级的 slot 着色：基础主题不动，层按
   * seq 顺序组合、逐 token 后来居上，移除一层就恢复它盖住的值。同一来源再次
   * 调用会整体替换该来源的层并重新叠到最上面（effect 重新注册的语义）。
   * 变化会以重新组合后的快照发出 `theme/change`。
   * @param source - 层标识；一个来源只有一层（动态包传自己的包 id）。
   * @param tokens - token 名 → `{ light, dark }` 值对。运行时校验（模型作者
   * 经动态包门面传进来的可能是无类型 JS）；只给字符串会抛教学式错误。
   * @returns 只移除本次调用建立的层的 disposer；该来源已被新层替换时是空操作。
   */
  overrideTokens(source: string, tokens: ThemeTokenOverrides): () => void {
    const layer = { seq: this.overrideSeq++, tokens: validateOverrides(source, tokens) }
    this.overrides.set(source, layer)
    this.publish()
    return () => {
      if (this.overrides.get(source) !== layer) return
      this.overrides.delete(source)
      this.publish()
    }
  }

  /** 当前选择是否跟随系统配色（`system` 或声明 `auto` 的生效主题）。 */
  private followsColorScheme(): boolean {
    if (this.preference === 'system') return true
    return this.themes.find(theme => theme.id === this.preference)?.colorScheme === 'auto'
  }

  /** 系统当前是否深色。 */
  private systemDark(): boolean {
    return this.media?.matches === true
  }

  /** 按选择解析出生效主题定义；选择尚未注册时回落到基础配色。 */
  private activeDefinition(): ThemeDefinition {
    const resolved = this.preference === 'system'
      ? (this.systemDark() ? 'dark' : 'light')
      : this.preference
    const defined = this.themes.find(theme => theme.id === resolved)
    if (defined !== undefined) return defined
    const fallback = this.systemDark() ? 'dark' : 'light'
    // 内置两项始终存在，这里不可能落空。
    return this.themes.find(theme => theme.id === fallback) ?? BUILTIN_THEMES[0] as ThemeDefinition
  }

  /**
   * 按定义与解析后的明暗取基础令牌表：单套色主题只有一份，`auto` 主题按
   * 方案取对应一侧。
   * @param definition - 生效主题定义。
   * @param scheme - 解析后的明暗。
   */
  private baseTokens(definition: ThemeDefinition, scheme: ThemeColorScheme): ThemeTokens {
    return definition.colorScheme === 'auto'
      ? (definition.palettes?.[scheme] ?? {})
      : definition.tokens
  }

  private buildSnapshot(): ThemeSnapshot {
    const definition = this.activeDefinition()
    const colorScheme: ThemeColorScheme = definition.colorScheme === 'auto'
      ? (this.systemDark() ? 'dark' : 'light')
      : definition.colorScheme
    return Object.freeze({
      preference: this.preference,
      active: Object.freeze({
        id: definition.id,
        colorScheme,
        tokens: this.composeTokens(this.baseTokens(definition, colorScheme), colorScheme),
      }),
      themes: Object.freeze([...this.themes]),
      revision: this.revision,
    })
  }

  /**
   * 把覆盖层合进基础令牌：按 seq 顺序、逐 token 后来居上，每个值取当前配色
   * 对应的一侧（呈现器只消费合成后的快照，无需了解覆盖层）。
   */
  private composeTokens(base: ThemeTokens, scheme: ThemeColorScheme): ThemeTokens {
    if (this.overrides.size === 0) return base
    const tokens: ThemeTokens = { ...base }
    for (const layer of [...this.overrides.values()].sort((a, b) => a.seq - b.seq)) {
      for (const [name, modes] of Object.entries(layer.tokens)) {
        tokens[name] = modes[scheme]
      }
    }
    return Object.freeze(tokens)
  }

  /** 采纳作用域里已被接受的选择，不回写。 */
  private adopt(): void {
    const section = this.host.getSnapshot().value
    if (section === undefined || this.preference === section.preference) return
    this.preference = section.preference
    this.publish()
  }

  private publish(): void {
    this.revision += 1
    this.snapshot = this.buildSnapshot()
    this.ctx.emit('theme/change', this.snapshot)
  }
}

/**
 * 覆盖层的运行时形状检查（模型作者经动态包门面传的是无类型 JS，静态类型在
 * 那里管不住）。返回逐 token 的防御性副本，调用方后续改动不会渗进存储的层。
 */
function validateOverrides(source: string, tokens: ThemeTokenOverrides): ThemeTokenOverrides {
  const validated: ThemeTokenOverrides = {}
  for (const [name, value] of Object.entries<unknown>(tokens)) {
    if (typeof value === 'string') {
      throw new TypeError(
        `theme override "${name}" from "${source}" is a bare string — pass { light: ${JSON.stringify(value)}, dark: ${JSON.stringify(value)} } `
        + '(repeat the value when it is the same in both palettes); a single value goes illegible when the user switches color scheme',
      )
    }
    if (typeof value !== 'object' || value === null
      || typeof (value as { light?: unknown }).light !== 'string'
      || typeof (value as { dark?: unknown }).dark !== 'string') {
      throw new TypeError(
        `theme override "${name}" from "${source}" must map to a { light, dark } pair of strings — one value per color scheme`,
      )
    }
    const modes = value as ThemeTokenModes
    validated[name] = { light: modes.light, dark: modes.dark }
  }
  return validated
}

function dynamicToken(name: string): ThemeTokenInspection {
  return {
    name,
    description: '当前客户端组合注册的主题 token。',
    valueType: 'CSS value',
    requiresLightAndDark: true,
    ...(name.startsWith('--') ? { cssVariable: name } : {}),
  }
}

/** 判断一个选择是否是内置偏好（供引导脚本与页面复用）。 */
export { isThemePreference }
