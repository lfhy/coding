/** 回合状态行短语池的取值维度。 */

/** 短语跟随界面语言切换：中文界面取中文短语，英文界面取英文短语。 */
export type TurnStatusLocale = 'zh' | 'en'

/** 阶段按回合已运行时长划分：起步、运行中、长时间运行，各有一段专属文案。 */
export type TurnStatusPhase = 'thinking' | 'running' | 'long'

/** 一个短语包：语言 × 阶段 → 短语列表。 */
export type TurnStatusPhraseSet = Record<TurnStatusLocale, Record<TurnStatusPhase, readonly string[]>>
