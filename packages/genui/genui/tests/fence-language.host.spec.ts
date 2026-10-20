import { describe, expect, it } from 'vitest'
import { extractGenuiFences } from '../src/plugin/fence-extraction.ts'
import { fenceFailures } from '../src/plugin/fence-diagnostics.ts'
import { GENUI_SECTION_TEXT } from '../src/plugin/index.ts'
import { createRenderUiTool, createValidateDshUiTool } from '../src/plugin/tool.ts'

/** 新模型契约使用规范围栏名；旧会话无需重写即可继续参与最终诊断。 */
describe('GenUI 围栏语言契约', () => {
  it.each(['gen-ui', 'dsh-ui'])('严格识别 %s 并沿用同一诊断', (language) => {
    const text = `\`\`\`${language}\n{not json\n\`\`\``
    expect(extractGenuiFences(text)).toEqual([{ raw: '{not json', closed: true, index: 1 }])
    expect(fenceFailures(text)[0]?.detail).toContain('error=invalid_json')
    expect(extractGenuiFences(`\`\`\`${language}-dark\n{}\n\`\`\``)).toEqual([])
  })

  it('系统与工具契约使用 gen-ui，不再提供面板入口', () => {
    expect(GENUI_SECTION_TEXT).toContain('```gen-ui')
    expect(GENUI_SECTION_TEXT).not.toContain('```dsh-ui')
    expect(GENUI_SECTION_TEXT).not.toContain('/panel')
    expect(createRenderUiTool().description).toContain('```gen-ui')
    const validator = createValidateDshUiTool()
    expect(validator.name).toBe('validate_dsh_ui')
    expect(validator.description).toContain('```gen-ui')
  })
})
