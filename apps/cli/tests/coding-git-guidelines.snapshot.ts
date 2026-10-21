/** 通过真实 Loader 和 Web runtime 固定新项目初始化及 Git 工作规则。 */

import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import AgentRegistry from 'coding-agent'
import { boot } from 'coding-app-boot'
import WebServer from 'coding-host-webserver'
import SystemPrompt, { renderPrompt } from 'coding-system-prompt'
import * as WebApp from 'coding-web-app'
import { expect, it } from 'vitest'

it('Web 默认提示词指导本地初始化与分步提交，但启动本身不创建仓库', async () => {
  const root = mkdtempSync(join(tmpdir(), 'coding-git-guidelines-'))
  let ctx: Context | undefined
  try {
    writeFileSync(join(root, 'cordis.yml'), [
      '- id: prompt',
      '  name: cordis:git-test-prompt',
      '- id: agents',
      '  name: cordis:git-test-agents',
      '- id: webserver',
      '  name: cordis:git-test-webserver',
      '  config:',
      "    host: '127.0.0.1'",
      '    port: 0',
      '- id: web-runtime',
      '  name: cordis:git-test-web-app',
      '  config:',
      '    openBrowser: false',
      '    printUrl: false',
      '    managedHost: false',
      '',
    ].join('\n'))
    ctx = await boot('coding-git-guidelines-snapshot', join(root, 'cordis.yml'), undefined, (host) => {
      // 只固定源码解析；提示词注册走实际消费方，不能由测试直接调用注册 helper。
      host.loader.builtins['git-test-prompt'] = SystemPrompt
      host.loader.builtins['git-test-agents'] = AgentRegistry
      host.loader.builtins['git-test-webserver'] = WebServer
      host.loader.builtins['git-test-web-app'] = WebApp
    })
    const prompt = ctx.get('systemPrompt')!
    const assembly = await prompt.assemble()
    const guidelines = assembly.sections.find(section => section.name === 'coding:guidelines')
    expect(guidelines).toBeDefined()
    const text = guidelines!.text
    const initializationAt = text.indexOf('# 新项目初始化\n\n')
    const organizationAt = text.indexOf('\n# 代码组织', initializationAt)
    expect(initializationAt).toBeGreaterThanOrEqual(0)
    expect(organizationAt).toBeGreaterThan(initializationAt)
    const initializationGuidance = text.slice(initializationAt, organizationAt)
    expect(renderPrompt(assembly)).toContain(initializationGuidance)
    expect(initializationGuidance).toContain('README.md')
    expect(initializationGuidance).toContain('AGENTS.md')
    expect(initializationGuidance).toContain('实现业务代码前')
    expect(initializationGuidance).toMatchSnapshot('新项目跨 harness 约定')
    const gitAt = text.indexOf('# Git 工作\n\n')
    const boundaryAt = text.indexOf('\n# 边界', gitAt)
    expect(gitAt).toBeGreaterThanOrEqual(0)
    expect(boundaryAt).toBeGreaterThan(gitAt)
    const gitGuidance = text.slice(gitAt, boundaryAt)
    expect(renderPrompt(assembly)).toContain(gitGuidance)
    expect(gitGuidance).toContain('git init')
    expect(gitGuidance).toContain('再立即创建一个本地 commit')
    expect(text).not.toContain('未经要求不提交')
    expect(gitGuidance).toMatchSnapshot()
    expect(existsSync(join(root, '.git'))).toBe(false)
  } finally {
    await ctx?.fiber.dispose()
    rmSync(root, { recursive: true, force: true })
  }
})
