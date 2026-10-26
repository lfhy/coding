// @vitest-environment jsdom
// 回合状态行短语轮换：阶段划分、界面语言选择、取词与防重复。

import { afterEach, describe, expect, it } from 'vitest'
import { codingPhrases } from '../src/client/chat/turn-status-phrases/coding.ts'
import { dailyPhrases } from '../src/client/chat/turn-status-phrases/daily.ts'
import { internetMemePhrases } from '../src/client/chat/turn-status-phrases/internetMeme.ts'
import { slackingPhrases } from '../src/client/chat/turn-status-phrases/slacking.ts'
import {
  pickTurnStatusPhrase, turnStatusLocale, turnStatusPhase, turnStatusPhrases,
  TURN_STATUS_LONG_AFTER_MS, TURN_STATUS_ROTATE_MS, TURN_STATUS_RUNNING_AFTER_MS,
} from '../src/client/chat/turn-status-phrases/index.ts'

const PACKS = [codingPhrases, dailyPhrases, internetMemePhrases, slackingPhrases]
const LOCALES = ['zh', 'en'] as const
const PHASES = ['thinking', 'running', 'long'] as const

afterEach(() => {
  document.documentElement.lang = ''
})

describe('回合状态行短语池', () => {
  it('四个包的每个阶段、每种语言都有非空短语，取词因此不需要空池回退', () => {
    for (const pack of PACKS) {
      for (const locale of LOCALES) {
        for (const phase of PHASES) {
          const phrases = pack[locale][phase]
          expect(phrases.length).toBeGreaterThan(0)
          for (const phrase of phrases) expect(phrase.trim()).not.toBe('')
        }
      }
    }
  })

  it('按阶段和语言拼接四个包的短语，顺序固定且不混入另一语言', () => {
    for (const locale of LOCALES) {
      for (const phase of PHASES) {
        const pool = turnStatusPhrases(phase, locale)
        expect(pool).toEqual(PACKS.flatMap(pack => pack[locale][phase]))
        expect(pool[0]).toBe(codingPhrases[locale][phase][0])
      }
    }
    expect(turnStatusPhrases('thinking', 'zh')).not.toEqual(turnStatusPhrases('thinking', 'en'))
  })
})

describe('阶段与语言', () => {
  it('按已运行时长划出起步、运行中与长时间运行，边界归入后一阶段', () => {
    expect(turnStatusPhase(0)).toBe('thinking')
    expect(turnStatusPhase(TURN_STATUS_RUNNING_AFTER_MS - 1)).toBe('thinking')
    expect(turnStatusPhase(TURN_STATUS_RUNNING_AFTER_MS)).toBe('running')
    expect(turnStatusPhase(TURN_STATUS_LONG_AFTER_MS - 1)).toBe('running')
    expect(turnStatusPhase(TURN_STATUS_LONG_AFTER_MS)).toBe('long')
    expect(turnStatusPhase(Number.POSITIVE_INFINITY)).toBe('long')
  })

  it('跟随文档语言选择短语池，未知语言按中文处理', () => {
    document.documentElement.lang = 'en'
    expect(turnStatusLocale()).toBe('en')
    document.documentElement.lang = 'en-US'
    expect(turnStatusLocale()).toBe('en')
    document.documentElement.lang = 'zh-CN'
    expect(turnStatusLocale()).toBe('zh')
    document.documentElement.lang = ''
    expect(turnStatusLocale()).toBe('zh')
  })
})

describe('取词', () => {
  const pool = ['第一句', '第二句', '第三句']

  it('首次选取取随机源给出的位置', () => {
    expect(pickTurnStatusPhrase(pool, null, () => 0)).toBe('第一句')
    expect(pickTurnStatusPhrase(pool, null, () => 0.5)).toBe('第二句')
    expect(pickTurnStatusPhrase(pool, null, () => 1)).toBe('第三句')
  })

  it('不与当前显示的一句重复，即使随机源正好指向它', () => {
    expect(pickTurnStatusPhrase(pool, '第一句', () => 0)).toBe('第二句')
    expect(pickTurnStatusPhrase(pool, '第三句', () => 0.999)).toBe('第二句')
  })

  it('只有一句可选时只能重复它', () => {
    expect(pickTurnStatusPhrase(['唯一一句'], '唯一一句', () => 0)).toBe('唯一一句')
  })

  it('空池返回 null，调用方保留上一句', () => {
    expect(pickTurnStatusPhrase([], '任意', () => 0)).toBeNull()
  })

  it('换词间隔为 10 秒', () => {
    expect(TURN_STATUS_ROTATE_MS).toBe(10_000)
  })
})
