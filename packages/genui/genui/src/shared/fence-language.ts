/** 新回复使用 gen-ui；历史 dsh-ui 消息继续由同一渲染和校验流程处理。 */
export const GENUI_FENCE_LANGUAGE = 'gen-ui'

/**
 * 判断 Markdown 原始语言是否属于 GenUI，避免把普通 JSON 围栏按内容误接管。
 * @param language - Markdown AST 或宿主代码块暴露的原始语言。
 * @returns 新语言名或历史别名返回 true；其他语言及缺失值返回 false。
 */
export function isGenuiFenceLanguage(language: string | null | undefined): boolean {
  return language === GENUI_FENCE_LANGUAGE || language === 'dsh-ui'
}
