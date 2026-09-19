/**
 * 校验 Agent Note 头部、生命周期章节、替代方案和已退役标记。
 * 分类与文件名由相邻的目录门禁负责；历史配对结构由配对门禁负责。
 * 中文与 legacy English canonical 的精确格式见 `.agents/notes/README.md`。
 */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { agentNoteRoot, walkAgentNoteTree } from './agent-note-tree.ts'

/** The date these format rules took effect; the grandfather comment is valid only before it. */
const FORMAT_ADOPTED = '2026-07-05'

/** The exact comment a pre-format Agent Note carries in place of `## Alternatives considered`. */
const GRANDFATHER = '<!-- agent-note-format: alternatives-not-recorded (pre-format Agent Note) -->'

/** The retired debt marker that flagged pre-format bodies; banned so it cannot creep back. */
const LEGACY_MARKERS = ['XXX: legacy ADR/RFC body format', 'XXX: legacy ADR/Agent Note body format']

/** Status-line grammar per lifecycle folder. */
const STATUS: Record<string, RegExp> = {
  proposed: /^Status: proposed$/,
  implemented: /^Status: implemented$/,
  rejected: /^Status: rejected — .+$/,
}

interface HeadingProfile {
  name: string
  problem: string
  alternatives: string
  required: Record<string, string[]>
  bannedImplemented: RegExp
}

/** 新中文 canonical 与历史英文 canonical 各自使用一套完整的必需章节词汇。 */
const HEADING_PROFILES: HeadingProfile[] = [
  {
    name: 'English',
    problem: '## Problem',
    alternatives: '## Alternatives considered',
    required: {
      proposed: ['## Proposal', '## Acceptance criteria', '## Risks'],
      implemented: ['## Decision', '## Consequences'],
      rejected: ['## Proposal'],
    },
    bannedImplemented: /^## (?:Proposal\b|Plan\b|Migration plan\b|Acceptance criteria\b)/i,
  },
  {
    name: '中文',
    problem: '## 问题',
    alternatives: '## 曾考虑的替代方案',
    required: {
      proposed: ['## 提案', '## 验收标准', '## 风险'],
      implemented: ['## 决策', '## 后果'],
      rejected: ['## 提案'],
    },
    bannedImplemented: /^## (?:提案|计划|迁移计划|验收标准)$/,
  },
]

const { notes, errors } = walkAgentNoteTree()

for (const note of notes) {
  const fail = (msg: string): void => {
    errors.push(`format: ${note.rel} — ${msg}`)
  }
  const lines = readFileSync(resolve(agentNoteRoot, note.rel), 'utf8').split('\n')
  // Format tokens inside fenced examples are not document structure.
  let inFence = false
  const prose = lines.filter((l) => {
    if (l.startsWith('```')) {
      inFence = !inFence
      return false
    }
    return !inFence
  })

  if (!/^# Agent Note: \S/.test(lines[0] ?? '')) fail('line 1 must be `# Agent Note: <title>`')
  if (lines[1] !== '') fail('line 2 must be blank')
  const status = STATUS[note.lifecycle]
  if (status !== undefined && !status.test(lines[2] ?? '')) {
    fail(`line 3 must match the ${note.lifecycle} status grammar (${String(status)})`)
  }
  if (lines[3] !== '') fail('line 4 must be blank')
  const statusLines = prose.filter(l => l.startsWith('Status:') && l !== lines[2])
  if (statusLines.length > 0 || prose.filter(l => l === lines[2]).length > 1) {
    fail('the line-3 `Status:` line must be the only one in the file')
  }

  const h2s = prose.filter(l => l.startsWith('## ')).map(l => l.trimEnd())
  const profile = HEADING_PROFILES.find(candidate => candidate.problem === h2s[0])
  if (profile === undefined) {
    fail(`the first section must be \`## 问题\` or legacy \`## Problem\` (got ${JSON.stringify(h2s[0] ?? '<none>')})`)
  } else {
    for (const required of profile.required[note.lifecycle] ?? []) {
      if (!h2s.includes(required)) fail(`missing the required ${profile.name} \`${required}\` section`)
    }
    if (note.lifecycle === 'implemented') {
      for (const h2 of h2s.filter(h => profile.bannedImplemented.test(h))) {
        fail(`\`${h2}\` is a proposal-era heading; an implemented Agent Note states shipped reality`)
      }
    }
  }

  const hasSection = profile !== undefined && h2s.includes(profile.alternatives)
  const hasGrandfather = prose.includes(GRANDFATHER)
  if (hasSection && hasGrandfather) fail('carries both `## Alternatives considered` and the grandfather comment — drop the comment')
  if (!hasSection && !hasGrandfather && profile !== undefined) fail(`missing the required \`${profile.alternatives}\` section`)
  if (hasGrandfather && (note.date >= FORMAT_ADOPTED || profile?.name === '中文')) {
    fail(`the grandfather comment is only valid for legacy English Agent Notes dated before ${FORMAT_ADOPTED}`)
  }

  if (prose.some(line => LEGACY_MARKERS.some(marker => line.includes(marker)))) fail('carries the retired legacy-format debt marker')
}

if (errors.length === 0) {
  console.log(`verify-agent-note-format: ${notes.length} Agent Note(s) checked, all conform to .agents/notes/README.md § 文件格式.`)
  process.exit(0)
}

console.error('verify-agent-note-format: violations found:')
for (const e of errors) console.error(`  ${e}`)
process.exit(1)
