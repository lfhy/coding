/**
 * 设置卡的分阶段表单模型：控件只记录草稿，保存时一次性写入设置命名空间。
 *
 * 每次设置写入都是带版本围栏的持久修改，所以输入框不能在按键时直写；草稿让
 * “屏幕上看到的”与“保存会存下的”始终一致。字段是否被用户层覆盖按存在性判断，
 * 不按取值比较：与组合默认值相等的覆盖仍是覆盖。
 */

import type { SettingsScope, SettingsScopeSnapshot } from 'coding-client-runtime/client'
import { createSnapshotStore, type SnapshotStore } from 'coding-client-runtime/client'

/** 一次保存中单个字段要执行的写入。 */
export type FieldWrite = { kind: 'set'; value: unknown } | { kind: 'clear' }

/** 一个字段在存储值与草稿文本之间的转换约定。 */
export interface CardFieldSpec {
  /** 命名空间设置节里的字段名。 */
  field: string
  /** 把存储值渲染成草稿文本；设置节没有该字段时为空串。 */
  format: (value: unknown) => string
  /** 草稿文本对应的写入；undefined 表示该文本不被接受，保存被阻止。 */
  parse: (text: string) => FieldWrite | undefined
}

/** 数字字段的合法区间；越界草稿与非法文本一样阻止保存。 */
export interface NumberBounds {
  /** 允许的最小值。 */
  min?: number
  /** 允许的最大值。 */
  max?: number
  /** 是否要求整数。 */
  integer?: boolean
}

/** 一个字段在控件上的呈现状态。 */
export interface CardFieldState {
  /** 控件渲染的草稿文本。 */
  text: string
  /** 保存后是否会在用户层留下该字段；草稿自己回答，预览保存结果。 */
  overridden: boolean
  /** 草稿是否不是该字段接受的值，从而阻止保存。 */
  invalid: boolean
}

/** 每张设置卡共用的表单状态。 */
export interface CardShell {
  /** 命名空间未服务到本客户端时为 false，卡片不渲染任何内容。 */
  available: boolean
  /** Host 是否接受写入。 */
  writable: boolean
  /** 表单是否含有保存会写入的修改。 */
  dirty: boolean
  /** 是否存在非法草稿，从而阻止保存。 */
  invalid: boolean
  /** 保存是否正在跨线。 */
  saving: boolean
  /** 上一次保存是否没有按草稿落盘；下一次编辑或保存会清除。 */
  failed: boolean
}

/** 设置卡注入给组件的写入动作。 */
export interface CardActions {
  /** 记录一个字段的草稿文本。 */
  edit: (field: string, text: string) => void
  /** 记录一次清空，保存后该字段重新继承组合层。 */
  resetField: (field: string) => void
  /** 写入全部草稿，再从 Host 接受的值重新播种。 */
  save: () => void
  /** 丢弃全部草稿。 */
  discard: () => void
}

/** 一个字段的待保存编辑。 */
interface StagedEdit {
  /** 控件渲染的草稿文本。 */
  text: string
  /** 为真时无论文本如何都清空该字段。 */
  clear: boolean
}

/** 一次保存要执行的字段写入。 */
interface PlannedWrite {
  /** 写入的字段。 */
  field: string
  /** 执行写入并报告 Host 之后是否持有草稿值；草稿非法时为 undefined。 */
  run: (() => Promise<boolean>) | undefined
}

/**
 * 文本字段：空草稿表示清空，使清空控件与恢复默认是同一动作。
 * @param field - 命名空间设置节里的字段名。
 * @returns 字段转换约定。
 */
export function textField(field: string): CardFieldSpec {
  return {
    field,
    format: value => typeof value === 'string' ? value : '',
    parse: (text) => {
      const trimmed = text.trim()
      return trimmed === '' ? { kind: 'clear' } : { kind: 'set', value: trimmed }
    },
  }
}

/**
 * 数字字段：空草稿清空该字段，非数字或越界草稿阻止保存。
 * @param field - 命名空间设置节里的字段名。
 * @param bounds - 合法区间与整数要求。
 * @returns 字段转换约定。
 */
export function numberField(field: string, bounds: NumberBounds = {}): CardFieldSpec {
  return {
    field,
    format: value => typeof value === 'number' ? String(value) : '',
    parse: (text) => {
      const trimmed = text.trim()
      if (trimmed === '') return { kind: 'clear' }
      const parsed = Number(trimmed)
      if (!Number.isFinite(parsed)) return undefined
      if (bounds.integer === true && !Number.isSafeInteger(parsed)) return undefined
      if (bounds.min !== undefined && parsed < bounds.min) return undefined
      if (bounds.max !== undefined && parsed > bounds.max) return undefined
      return { kind: 'set', value: parsed }
    },
  }
}

/**
 * 布尔字段：开关只写入 true 或 false，空值保留在组合层。
 * @param field - 命名空间设置节里的字段名。
 * @returns 字段转换约定。
 */
export function booleanField(field: string): CardFieldSpec {
  return {
    field,
    format: value => typeof value === 'boolean' ? String(value) : '',
    parse: (text) => {
      const trimmed = text.trim()
      if (trimmed === '') return { kind: 'clear' }
      if (trimmed === 'true') return { kind: 'set', value: true }
      if (trimmed === 'false') return { kind: 'set', value: false }
      return undefined
    },
  }
}

/**
 * 枚举字段：只接受声明过的取值，其余草稿阻止保存。
 * @param field - 命名空间设置节里的字段名。
 * @param choices - 允许的取值集合。
 * @returns 字段转换约定。
 */
export function choiceField(field: string, choices: readonly string[]): CardFieldSpec {
  return {
    field,
    format: value => typeof value === 'string' && choices.includes(value) ? value : '',
    parse: (text) => {
      const trimmed = text.trim()
      return choices.includes(trimmed) ? { kind: 'set', value: trimmed } : undefined
    },
  }
}

/**
 * 在一份设置命名空间上暂存一张卡的修改，并在保存时写入。
 *
 * 表单经快照存储发布：槽位组件按选择器读取，而设置作用域与本地草稿各自变化，
 * 每次投影都从两者重新构建。
 */
export class CardForm<T> {
  private readonly specs: Map<string, CardFieldSpec>
  private readonly staged = new Map<string, StagedEdit>()
  private readonly listeners = new Set<() => void>()
  private saving = false
  private failed = false

  /**
   * @param scope - 该卡命名空间绑定的设置作用域。
   * @param specs - 本卡编辑的设置节字段。
   */
  constructor(
    private readonly scope: SettingsScope<T>,
    specs: CardFieldSpec[],
  ) {
    this.specs = new Map(specs.map(spec => [spec.field, spec]))
    scope.subscribe(() => { this.publish() })
  }

  /**
   * 发布表单投影，在设置作用域或草稿变化时重建。
   * @param project - 从表单当前读取构建卡片状态。
   * @returns 组件经绑定选择器读取的存储。
   */
  bind<S>(project: () => S): SnapshotStore<S> {
    const store = createSnapshotStore(project())
    this.listeners.add(() => { store.set(project()) })
    return store
  }

  /**
   * 读取卡片级状态：Host 服务了哪些内容，以及保存会做什么。
   * @returns 每张卡共用的表单状态。
   */
  shell(): CardShell {
    const snapshot = this.scope.getSnapshot()
    const plan = this.plan()
    return {
      available: snapshot.status === 'ready',
      writable: snapshot.writable,
      dirty: plan.length > 0,
      invalid: plan.some(item => item.run === undefined),
      saving: this.saving,
      failed: this.failed,
    }
  }

  /**
   * 读取一个字段的状态。
   * @param field - 本卡声明过的字段名。
   * @returns 草稿文本、保存后是否留下覆盖，以及是否非法。
   */
  field(field: string): CardFieldState {
    const spec = this.spec(field)
    const staged = this.staged.get(field)
    if (staged === undefined) {
      return { text: spec.format(this.sectionValue(field)), overridden: this.stored(field), invalid: false }
    }
    const write = staged.clear ? { kind: 'clear' as const } : spec.parse(staged.text)
    return {
      text: staged.text,
      overridden: write?.kind === 'set',
      invalid: write === undefined,
    }
  }

  /**
   * 构建与本表单绑定的编辑、重置、保存和丢弃动作。
   * @returns 设置卡注入的动作集合。
   */
  actions(): CardActions {
    return {
      edit: (field, text) => { this.stage(field, { text, clear: false }) },
      resetField: (field) => {
        this.stage(field, { text: this.spec(field).format(this.baseValue(field)), clear: true })
      },
      save: () => { void this.save() },
      discard: () => {
        if (this.staged.size === 0 && !this.failed) return
        this.staged.clear()
        this.failed = false
        this.publish()
      },
    }
  }

  /**
   * 写入全部草稿，再从 Host 接受的值重新播种。
   *
   * 只有 Host 能判定一个值是否被接受（它的校验器持有 schema 无法表达的约束），
   * 所以结果从设置节读回而不是在这里预测。没有落盘的保存保留草稿，用户可以直接
   * 修正，而不是重新输入。
   * @returns 全部写入与读回结束。
   */
  async save(): Promise<void> {
    const plan = this.plan()
    const writes = plan.flatMap(item => item.run === undefined ? [] : [item.run])
    if (plan.length === 0 || this.saving || writes.length !== plan.length) return
    this.saving = true
    this.failed = false
    this.publish()
    let landed = true
    for (const write of writes) {
      landed = await write() && landed
    }
    if (landed) this.staged.clear()
    this.saving = false
    this.failed = !landed
    this.publish()
  }

  /**
   * 一次保存会写入的全部草稿。草稿非法时不带写入，表单仍然算脏，保存被拒绝而
   * 不是静默丢弃这条编辑。
   * @returns 按字段登记顺序排列的待写入项。
   */
  private plan(): PlannedWrite[] {
    const plan: PlannedWrite[] = []
    for (const [field, staged] of this.staged) {
      const spec = this.spec(field)
      if (staged.clear) {
        if (this.stored(field)) plan.push({ field, run: () => this.clear(field) })
        continue
      }
      if (staged.text === spec.format(this.sectionValue(field))) continue
      const write = spec.parse(staged.text)
      if (write === undefined) plan.push({ field, run: undefined })
      else if (write.kind === 'clear') plan.push({ field, run: () => this.clear(field) })
      else plan.push({ field, run: () => this.store(field, write.value) })
    }
    return plan
  }

  private async clear(field: string): Promise<boolean> {
    await this.scope.unset(field)
    return !this.stored(field)
  }

  private async store(field: string, value: unknown): Promise<boolean> {
    await this.scope.set(field, value)
    return this.userLayer()?.[field] === value
  }

  private stage(field: string, edit: StagedEdit): void {
    this.staged.set(field, edit)
    this.failed = false
    this.publish()
  }

  private spec(field: string): CardFieldSpec {
    const spec = this.specs.get(field)
    // 每个调用点都写本卡声明过的字段；缺失说明接线错误，不能退化成静默失效的控件。
    if (spec === undefined) throw new Error(`settings card has no field ${field}`)
    return spec
  }

  private snapshotOf(): SettingsScopeSnapshot<T> {
    return this.scope.getSnapshot()
  }

  private sectionValue(field: string): unknown {
    return (this.snapshotOf().value as Record<string, unknown> | undefined)?.[field]
  }

  private baseValue(field: string): unknown {
    return (this.snapshotOf().base as Record<string, unknown> | undefined)?.[field]
  }

  private userLayer(): Record<string, unknown> | undefined {
    return this.snapshotOf().user as Record<string, unknown> | undefined
  }

  private stored(field: string): boolean {
    const user = this.userLayer()
    return user !== undefined && Object.hasOwn(user, field)
  }

  private publish(): void {
    for (const listener of this.listeners) listener()
  }
}
