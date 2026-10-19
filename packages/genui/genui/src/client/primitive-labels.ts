/**
 * 本仓库 UI 原语需要的本地化标签。
 *
 * 原语以普通 label 对象接收界面文案，因此这里按当前 locale 每次渲染重建
 * （`labelsOf*()`）而不是模块加载时冻结——语言切换要能到达已经在屏幕上的
 * diff 或 JSON 树。DiffBlock 在本仓库不接收 labels（内置中文文案），
 * 仅保留代码块与 JSON 树两组。
 */
import type { JsonTreeLabels } from 'coding-client-ui-primitives'
import { t } from './i18n/index.ts'

/** 代码块（围栏内或节点内）的复制标签。 */
export function codeBlockLabels(): { copyLabel: string; copiedLabel: string } {
  return {
    copyLabel: t('label.copy'),
    copiedLabel: t('label.copied'),
  }
}

/** 内联 GenUI JSON 树的界面标签，跟随当前 locale。 */
export function jsonTreeLabels(): JsonTreeLabels {
  return {
    copyValue: t('label.copyValue'),
    copyJson: t('label.copyJson'),
    copyPath: t('label.copyPath'),
    copyPrettyJson: t('label.copyPrettyJson'),
    copyCompactJson: t('label.copyCompactJson'),
    copied: t('label.copiedDone'),
    copyFailed: t('label.copyFailed'),
    collapseNode: t('label.collapseNode'),
    expandNode: t('label.expandNode'),
    /** JSON 树复制动作的提示文案。 */
    copyButtonTitle(action) { return t('label.copyButtonTitle', { action }) },
  }
}
