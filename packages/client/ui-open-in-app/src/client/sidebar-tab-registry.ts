/**
 * 右侧工作台标签类型的静态注册表。内容组件以定义的 id 单独注册；这里不保存会话、标签或渲染状态。
 * 地址路由依次比较优先级段、最长匹配 pattern 和注册先后，显式 kind 不检查 pattern。
 */

import type { ComponentType } from 'react'
import picomatch from 'picomatch/posix'

/** extension 可接管同 kind 的 builtin；fallback 不与其他定义共存。 */
export type SidebarRightTabPriority = 'extension' | 'builtin' | 'fallback'

const RANKS: Readonly<Record<SidebarRightTabPriority, number>> = {
  extension: 3,
  builtin: 2,
  fallback: 1,
}

/** 引导页的一项入口；文案函数在读取时调用，以便语言切换生效。 */
export interface SidebarRightGuideEntry {
  readonly id: string
  readonly order: number
  readonly title: () => string
  readonly description?: () => string
  readonly commandId?: string
  readonly icon?: ComponentType<{ size?: number; className?: string }>
}

/** 引导项附带当前生效的实现 id，内容座位以该 id 分派。 */
export interface SidebarRightGuideBox extends SidebarRightGuideEntry {
  readonly kind: string
  readonly providerId: string
}

/** 标签类型定义；`multiple` 和 `keepMounted` 由单面板消费方解释，注册表不创建标签。 */
export interface SidebarRightTabDefinition {
  /** 实现 id 唯一；同 kind 的 extension 与 builtin 分别使用自己的 id。 */
  readonly id: string
  readonly kind: string
  /** 缺省为每个 kind 一个标签。 */
  readonly multiple?: boolean
  /** 访问后隐藏仍保留内容组件，默认 false。 */
  readonly keepMounted?: boolean
  /** 含冒号时匹配完整 URI，否则匹配 URI path 任意层级；无效 URI 不匹配 path pattern。 */
  readonly patterns?: readonly string[]
  /** 省略时为 extension。 */
  readonly priority?: SidebarRightTabPriority
  /**
   * 在 pattern 匹配后否决地址；显式指定 kind 时仍会检查。
   * @param address - 待打开的地址。
   * @returns 是否允许此类型打开。
   */
  readonly canOpen?: (address: string) => boolean
  /**
   * 打开时生成标签标题，之后的语言切换不修改已保存的标签标题。
   * @param address - 待打开的地址。
   * @returns 标签标题。
   */
  readonly title: (address: string) => string
  readonly guide?: readonly SidebarRightGuideEntry[]
}

/** 一次地址路由的标签身份与标题；相同地址的重复打开由消费方去重。 */
export interface SidebarRightTabClaim {
  readonly kind: string
  readonly contentId: string
  readonly title: string
}

interface Registered {
  readonly definition: SidebarRightTabDefinition
  readonly band: SidebarRightTabPriority
  readonly matchers: readonly { pattern: string; test: (address: string) => boolean }[]
  readonly order: number
}

interface KindSlot {
  inForce: Registered
  shadowed: Registered | undefined
}

function canCoexist(slot: KindSlot, band: SidebarRightTabPriority): boolean {
  return band !== 'fallback' && slot.inForce.band !== 'fallback'
    && slot.inForce.band !== band && slot.shadowed === undefined
}

function matcherFor(pattern: string): (address: string) => boolean {
  const whole = pattern.includes(':')
  const match = picomatch(pattern, { nocase: true, dot: true, ...whole ? {} : { basename: true } })
  return (address) => {
    if (whole) return match(address)
    try {
      return match(new URL(address).pathname)
    } catch {
      return false
    }
  }
}

/** 单面板的类型目录；实例应由提供方创建，再以 `ctx.effect` 持有每项注册。 */
export class SidebarRightTabRegistry {
  private readonly kinds = new Map<string, KindSlot>()
  private readonly ids = new Map<string, Registered>()
  private readonly listeners = new Set<() => void>()
  private registrations = 0
  private version = 0
  private cached: readonly SidebarRightTabDefinition[] = []
  private guideEntries: readonly SidebarRightGuideBox[] = []

  /**
   * 注册标签类型；同 kind 只允许一个 extension 和一个 builtin，较高段暂时接管。
   * @param definition - 插件贡献的静态类型。
   * @returns 幂等且仅撤销此次注册的 disposer，调用者应交给自己的 `ctx.effect`。
   * @throws id、引导项 id 重复，或 kind 已被不兼容的优先级占用时抛错。
   */
  register(definition: SidebarRightTabDefinition): () => void {
    const { id, kind } = definition
    const entries = definition.guide ?? []
    if (new Set(entries.map(entry => entry.id)).size !== entries.length) {
      throw new Error(`sidebarRight: duplicate guide entry id in "${id}"`)
    }
    const band = definition.priority ?? 'extension'
    if (this.ids.has(id)) throw new Error(`sidebarRight: tab type id "${id}" is already registered`)
    const held = this.kinds.get(kind)
    if (held !== undefined && !canCoexist(held, band)) {
      throw new Error(`sidebarRight: tab kind "${kind}" is already registered (${held.inForce.band})`)
    }
    const entry: Registered = {
      definition,
      band,
      matchers: (definition.patterns ?? []).map(pattern => ({ pattern, test: matcherFor(pattern) })),
      order: ++this.registrations,
    }
    this.ids.set(id, entry)
    if (held === undefined) {
      this.kinds.set(kind, { inForce: entry, shadowed: undefined })
    } else if (RANKS[band] > RANKS[held.inForce.band]) {
      held.shadowed = held.inForce
      held.inForce = entry
    } else {
      held.shadowed = entry
    }
    this.refresh()

    let disposed = false
    return () => {
      if (disposed) return
      disposed = true
      if (this.ids.get(id) !== entry) return
      this.ids.delete(id)
      const slot = this.kinds.get(kind)
      if (slot === undefined) return
      if (slot.inForce !== entry) {
        if (slot.shadowed !== entry) return
        slot.shadowed = undefined
      } else if (slot.shadowed === undefined) {
        this.kinds.delete(kind)
      } else {
        slot.inForce = slot.shadowed
        slot.shadowed = undefined
      }
      this.refresh()
    }
  }

  private active(): Registered[] {
    return [...this.kinds.values()].map(slot => slot.inForce).sort((a, b) => a.order - b.order)
  }

  /** @returns 按注册顺序排列、两次变更间引用稳定的生效定义。 */
  entries(): readonly SidebarRightTabDefinition[] {
    return this.cached
  }

  /** @returns 按 order 排列、相同 order 依生效定义的注册先后排列的引导项。 */
  guide(): readonly SidebarRightGuideBox[] {
    return this.guideEntries
  }

  /**
   * 查询 kind 的当前实现，包括 extension 对 builtin 的临时接管。
   * @param kind - 标签类型。
   * @returns 生效定义，未注册时为 undefined。
   */
  get(kind: string): SidebarRightTabDefinition | undefined {
    return this.kinds.get(kind)?.inForce.definition
  }

  /**
   * 查询实现 id 是否仍注册；被 extension 遮蔽的 builtin 仍视为注册。
   * @param id - 实现身份。
   * @returns 该实现的 disposer 尚未撤销时为 true。
   */
  has(id: string): boolean {
    return this.ids.has(id)
  }

  /**
   * 路由 URI：含冒号的 glob 匹配完整地址，其余 glob 对 URI path 作不区分大小写的 basename 匹配。
   * @param address - URI 地址。
   * @returns 依优先级段、最长匹配 pattern、注册先后排序的候选定义。
   */
  candidates(address: string): readonly SidebarRightTabDefinition[] {
    const candidates: { entry: Registered; length: number }[] = []
    for (const entry of this.active()) {
      let length = -1
      for (const matcher of entry.matchers) {
        if (matcher.test(address) && matcher.pattern.length > length) length = matcher.pattern.length
      }
      if (length < 0 || entry.definition.canOpen?.(address) === false) continue
      candidates.push({ entry, length })
    }
    candidates.sort((a, b) => RANKS[b.entry.band] - RANKS[a.entry.band]
      || b.length - a.length || a.entry.order - b.entry.order)
    return candidates.map(candidate => candidate.entry.definition)
  }

  /**
   * 取得地址的最佳类型，或显式指定 kind（不检查其 glob，仍调用 canOpen）。
   * @param address - 待打开地址。
   * @param kind - 可选的指定类型。
   * @returns 标签类型、以地址自身为 contentId 的身份，以及打开时生成的标题。
   * @throws 没有候选、kind 未注册或 canOpen 否决时抛错。
   */
  claim(address: string, kind?: string): SidebarRightTabClaim {
    let definition: SidebarRightTabDefinition | undefined
    if (kind !== undefined) {
      definition = this.get(kind)
      if (definition === undefined) throw new Error(`sidebarRight: no tab type is registered as "${kind}"`)
      if (definition.canOpen?.(address) === false) {
        throw new Error(`sidebarRight: tab type "${kind}" refuses "${address}"`)
      }
    } else {
      definition = this.candidates(address)[0]
      if (definition === undefined) throw new Error(`sidebarRight: no registered tab type claims "${address}"`)
    }
    return { kind: definition.kind, contentId: address, title: definition.title(address) }
  }

  /**
   * 订阅注册及注销引起的同步版本变更。
   * @param listener - 失效通知函数。
   * @returns 取消订阅函数。
   */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  /** @returns 两次注册表变更间恒定的版本号，供框架绑定观察源。 */
  getSnapshot(): number {
    return this.version
  }

  private refresh(): void {
    this.cached = this.active().map(entry => entry.definition)
    this.guideEntries = this.cached.flatMap(definition => (definition.guide ?? []).map(entry => ({
      ...entry,
      kind: definition.kind,
      providerId: definition.id,
    }))).sort((a, b) => a.order - b.order)
    this.version++
    for (const listener of [...this.listeners]) listener()
  }
}
