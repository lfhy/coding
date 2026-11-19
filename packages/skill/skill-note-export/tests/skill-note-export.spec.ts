/**
 * `note-export` 技能包的注册、加载与卸载契约。
 *
 * 正文按关键动作断言：目录描述可以改写，但「产物落到用户主目录、只读原笔记、先探测
 * pandoc 与无头浏览器、缺工具就如实说明」这条操作顺序是技能存在的理由。命令本身也钉住，
 * 换了转换管线就该同步改正文与这里。
 */

import { readFile } from 'node:fs/promises'
import { Context } from '@deepseek-ai/cordis'
import { FsRegistry } from 'coding-fs'
import { describe, expect, it } from 'vitest'
import SkillRegistry, { renderSkillContent } from 'coding-skill'
import * as SkillNoteExport from 'coding-skill-note-export'

const bodyUrl = new URL('../assets/note-export.md', import.meta.url)
const resourcePrefix = '${INTERNAL_SKILL_DIR}/coding-skill-note-export'
const description = '把笔记导出成 Word（.docx）、PDF 或图片（.png）时使用：产物默认放到用户主目录的 `笔记导出` 目录，用户能在访达／资源管理器里直接看到；先用 pandoc 转格式、再用无头 Chrome 打印 PDF 或截图，逐页出图用 pdftoppm；导出只读原笔记，不改写不移动，写主目录被沙箱拒绝时按提示申请一次升权或退回笔记目录并说明位置。'

describe('bundled note-export skill', () => {
  it('registers, loads, and unregisters its published instructions', async () => {
    const ctx = new Context()
    await ctx.plugin(SkillRegistry)
    // 内置技能的展示路径是虚拟前缀，插件挂载时把它注册到文件系统。
    await ctx.plugin(FsRegistry)
    const fiber = await ctx.plugin(SkillNoteExport)
    try {
      // 插件挂载时把虚拟前缀登记到文件系统，模型之后才能按前缀读到资产。
      expect(ctx.fs.pathAliasPrefixes).toEqual([resourcePrefix])
      expect(await ctx.skills.list()).toEqual([{
        name: 'note-export',
        description,
        invocation: { modelInvocable: true, userInvocable: true },
        provider: 'note-export',
        source: 'bundled',
        resourceBase: { kind: 'alias', path: resourcePrefix },
      }])
      const loaded = await ctx.skills.get('note-export')
      if (loaded === undefined) throw new Error('bundled note-export skill is unavailable')
      expect(loaded.content).toBe(await readFile(bodyUrl, 'utf8'))
      expect(renderSkillContent(loaded)).toContain('<skill_instructions>')

      // 落点是用户主目录下的固定目录：主目录之外的位置要按沙箱提示处理，不能假装写成功。
      expect(loaded.content).toContain('out="$HOME/笔记导出"')
      expect(loaded.content).toContain('mkdir -p "$out"')
      expect(loaded.content).toContain('workspace-write')
      expect(loaded.content).toContain('升权')
      expect(loaded.content).toContain('退回笔记目录下的 `导出/`')
      // 导出是只读原笔记的附加产物。
      expect(loaded.content).toContain('不改写、不移动、不重命名')
      expect(loaded.content).toContain('不覆盖已有文件')

      // 转换链路：先探测工具，再按格式分流。
      expect(loaded.content).toContain('command -v pandoc')
      expect(loaded.content).toContain('pandoc "$note" -o "$out/项目周报.docx" --from gfm+tex_math_dollars')
      expect(loaded.content).toContain('--metadata pagetitle="项目周报"')
      expect(loaded.content).toContain('--print-to-pdf="$out/项目周报.pdf"')
      expect(loaded.content).toContain('--screenshot="$out/项目周报.png"')
      expect(loaded.content).toContain('pdftoppm -r 150 -png')
      expect(loaded.content).toContain('sips -s format png')
      // 缺工具时安装要用户同意，并给出应用内导出这条退路。
      expect(loaded.content).toContain('brew install pandoc')
      expect(loaded.content).toContain('winget install --id JohnMacFarlane.Pandoc')
      expect(loaded.content).toContain('不要自行联网安装')
      // 失败要如实汇报，不能把没生成的文件说成已生成。
      expect(loaded.content).toContain('ls -l "$out"')
      expect(loaded.content).toContain('不要用「已导出」掩盖失败')
      // 与应用内导出的差异（黑体、公式、高亮）必须写明，否则模型会声称两者一致。
      expect(loaded.content).toContain('不是黑体')
      expect(loaded.content).toContain('KaTeX 渲染')
    } finally {
      await fiber.dispose()
    }
    expect(await ctx.skills.list()).toEqual([])
  })
})
