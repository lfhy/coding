/** 技能工具行的本地化文案。 */

/** 本插件拥有的文案命名空间。 */
export const NS = 'skill'

/** 简体中文词典，作为键集合的来源。 */
export const zh = {
  'row.running': '正在加载 skill',
  'row.failed': 'skill 加载失败',
  'row.stopped': 'skill 加载已中止',
  'row.instructions': '说明',
  'row.unnamed': '技能',
  'menu.userOnly': '仅用户',
} satisfies Record<string, string>

/** 技能文案的键集合。 */
export type SkillKey = keyof typeof zh

/** 与中文键集合保持完整对应的英文词典。 */
export const en = {
  'row.running': 'Loading skill',
  'row.failed': 'Skill load failed',
  'row.stopped': 'Skill load stopped',
  'row.instructions': 'Instructions',
  'row.unnamed': 'Skill',
  'menu.userOnly': 'user-only',
} satisfies Record<SkillKey, string>
