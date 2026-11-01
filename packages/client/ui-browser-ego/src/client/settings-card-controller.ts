/** Agent 浏览器设置卡的暂存表单：把 `ego-browser` 设置节映射成卡片的控件状态。 */

import type { SettingsScope, SnapshotStore } from 'coding-client-runtime/client'
import {
  CardForm, type CardActions, type CardFieldState, type CardShell,
} from './card-form.ts'
import {
  CARD_FIELD_KEYS, FIELD_DESCRIPTORS, fieldSpec, type CardFieldKey,
} from './settings-fields.ts'
import type { EgoBrowserSettings } from './settings.ts'

/** 设置卡渲染的状态：卡片级表单状态加上每个字段的草稿。 */
export interface EgoBrowserCardState extends CardShell {
  /** 按字段名索引的控件状态。 */
  readonly fields: Readonly<Record<CardFieldKey, CardFieldState>>
}

/** 设置卡槽位注入的业务面。 */
export interface EgoBrowserCardFace extends CardActions {
  hooks: {
    /** 由渲染器绑定为 useEgoBrowserCard 的卡片快照。 */
    egoBrowserCard: SnapshotStore<EgoBrowserCardState>
  }
}

/**
 * 把设置节绑定到设置卡的分阶段表单。
 *
 * 表单在每个字段被编辑时只发布草稿；保存时按目录顺序写入 `set`/`unset`，
 * 由 Host 决定是否接受，再按读回结果清除草稿。
 */
export class EgoBrowserCardController {
  private readonly form: CardForm<EgoBrowserSettings>
  private readonly store: SnapshotStore<EgoBrowserCardState>

  /** @param scope - `ego-browser` 命名空间绑定的设置作用域。 */
  constructor(scope: SettingsScope<EgoBrowserSettings>) {
    this.form = new CardForm(scope, FIELD_DESCRIPTORS.map(fieldSpec))
    this.store = this.form.bind(() => this.projection())
  }

  private projection(): EgoBrowserCardState {
    const entries = CARD_FIELD_KEYS.map(field => [field, this.form.field(field)] as const)
    return {
      ...this.form.shell(),
      fields: Object.fromEntries(entries) as Record<CardFieldKey, CardFieldState>,
    }
  }

  /**
   * 构建设置卡槽位注入的业务面。
   * @returns 卡片快照与表单动作。
   */
  inject(): EgoBrowserCardFace {
    return { hooks: { egoBrowserCard: this.store }, ...this.form.actions() }
  }
}
