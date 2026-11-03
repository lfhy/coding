import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const overviewCss = readFileSync(fileURLToPath(new URL('../src/client/skeleton/OverviewCard.module.css', import.meta.url)), 'utf8')
const conversationCss = readFileSync(fileURLToPath(new URL('../src/client/skeleton/ConversationRoot.module.css', import.meta.url)), 'utf8')

/** 概览卡沿用对话列底色，主题与壁纸切换时与页面保持同色。 */
describe('会话概览卡表面', () => {
  it('使用对话列的背景变量', () => {
    const overview = overviewCss.match(/\.card\s*\{[^}]*\bbackground:\s*var\((--dsw-[\w-]+)\);/)?.[1]
    const conversation = conversationCss.match(/\.root\s*\{[^}]*\bbackground:\s*var\((--dsw-[\w-]+)\);/)?.[1]
    expect(overview).toBe('--dsw-alias-bg-base')
    expect(overview).toBe(conversation)
  })
})
