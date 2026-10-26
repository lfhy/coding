/**
 * 回合状态行的短语轮换：从移植来的四个短语包（coding / daily /
 * internet-memes / slacking）按当前阶段和界面语言取词。
 *
 * 短语只是运行中的装饰文案，不承载状态；读屏文案由状态行自己给出。四个包的
 * 每个阶段、每种语言都至少有一条短语（`tests/turn-status-phrases.client.spec.ts`
 * 守住这个前提），所以取词不做空池回退。
 */
import { codingPhrases } from './coding.ts'
import { dailyPhrases } from './daily.ts'
import { internetMemePhrases } from './internetMeme.ts'
import { slackingPhrases } from './slacking.ts'
import type { TurnStatusLocale, TurnStatusPhase } from './types.ts'

export type { TurnStatusLocale, TurnStatusPhase } from './types.ts'

/** 四个包按固定顺序拼接，构成同一阶段、同一语言的可选短语全集。 */
const PACKS = [codingPhrases, dailyPhrases, internetMemePhrases, slackingPhrases] as const

/** 起步阶段的上界，与状态行出现计时的门槛一致。 */
export const TURN_STATUS_RUNNING_AFTER_MS = 15_000

/** 长时间运行阶段的下界。 */
export const TURN_STATUS_LONG_AFTER_MS = 60_000

/** 两次换词之间的间隔。 */
export const TURN_STATUS_ROTATE_MS = 10_000

/**
 * 由已运行时长得出阶段。
 * @param elapsedMs 回合已运行毫秒数；负值按起步阶段处理。
 * @returns 起步 / 运行中 / 长时间运行。
 */
export function turnStatusPhase(elapsedMs: number): TurnStatusPhase {
  if (elapsedMs < TURN_STATUS_RUNNING_AFTER_MS) return 'thinking'
  return elapsedMs < TURN_STATUS_LONG_AFTER_MS ? 'running' : 'long'
}

/**
 * 当前界面语言。语言插件在活动语言切换时同步维护 `<html lang>`，因此读文档语言
 * 就能与本视图 `t` 座位所用的语言一致。
 * @returns 中文或英文短语池的选择。
 */
export function turnStatusLocale(): TurnStatusLocale {
  return document.documentElement.lang.toLowerCase().startsWith('en') ? 'en' : 'zh'
}

/**
 * 当前阶段可选的短语全集。
 * @param phase 回合阶段。
 * @param locale 界面语言。
 * @returns 四个包在该阶段和语言下的短语，顺序固定。
 */
export function turnStatusPhrases(phase: TurnStatusPhase, locale: TurnStatusLocale): readonly string[] {
  return PACKS.flatMap(pack => pack[locale][phase])
}

/**
 * 抽取下一条短语，尽量不与正在显示的一条重复。
 * @param pool 可选短语。
 * @param previous 当前显示的短语；为 null 时表示首次选取。
 * @param random 随机源（返回 0 到 1），测试注入固定值即可得到确定结果。
 * @returns 选中的短语；池为空时返回 null，调用方保留上一句或不显示。
 */
export function pickTurnStatusPhrase(
  pool: readonly string[],
  previous: string | null,
  random: () => number = Math.random,
): string | null {
  const candidates = pool.length > 1 && previous !== null
    ? pool.filter(candidate => candidate !== previous)
    : pool
  if (candidates.length === 0) return null
  const index = Math.min(candidates.length - 1, Math.max(0, Math.floor(random() * candidates.length)))
  return candidates[index] ?? null
}
