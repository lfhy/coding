/**
 * 文档网站的单语言发布清单。
 *
 * Markdown 仍留在所属的文档层级；本清单把每个中文定稿源投影到 `root`
 * locale 的唯一路由树。仓库不再维护英文对侧，`foo.md` 即中文定稿。
 */

/** VitePress 站点的 locale 键，单语言站点只有 `root`。 */
export type DocsLocale = 'root'

/** 侧边栏集合，按顶层模块命名。 */
export type DocsSidebar =
  | 'zh-guide'
  | 'zh-develop'
  | 'zh-reference'

/** 投影进 VitePress 源树的一页。 */
export interface DocsPage {
  /** 拥有该投影的 VitePress locale，恒为 `root`。 */
  locale: DocsLocale
  /** 该路由投影的定稿源的语言；除生成目录外均为中文。 */
  contentLocale: 'zh-CN' | 'en-US'
  /** 仓库相对的中文定稿 Markdown 源。 */
  source: string
  /** VitePress 路由，含 `.md` 后缀。 */
  route: string
  /** 侧边栏中显示的导航标签。 */
  label: string
  /** 拥有该页的侧边栏集合，站点首页为 null。 */
  sidebar: DocsSidebar | null
  /** 侧边栏内的分组标签。 */
  section: string
  /** 分组内的稳定顺序。 */
  order: number
  /** 该页 VitePress 大纲收录的标题层级。 */
  outline?: number | readonly [number, number] | 'deep' | false
  /** 解析到该页的额外仓库路径。 */
  sourceAliases?: string[]
}

/** 清单条目：除去固定的 locale 与默认内容语言后的页面字段。 */
type ManifestEntry = Omit<DocsPage, 'locale' | 'contentLocale'> & {
  /** 定稿源是英文生成目录时显式声明；缺省按中文处理。 */
  contentLocale?: 'en-US'
}

/**
 * 把一条清单条目补齐为发布页面。
 *
 * @param entry 不带固定字段的清单条目。
 * @returns 固定投影到 `root` locale、默认中文内容语言的页面。
 */
function zhPage(entry: ManifestEntry): DocsPage {
  return { locale: 'root', contentLocale: 'zh-CN', ...entry }
}

const homeAndGuide: DocsPage[] = [
  zhPage({
    source: 'docs/user/index.md',
    route: 'index.md',
    label: 'Coding',
    sidebar: null,
    section: '首页',
    order: 0,
  }),
  zhPage({
    source: 'docs/user/guide/index.md',
    route: 'guide/quickstart.md',
    label: '使用 Web UI',
    sidebar: 'zh-guide',
    section: '入门',
    order: 1,
    sourceAliases: ['docs/user/guide'],
  }),
  zhPage({
    source: 'docs/user/guide/providers.md',
    route: 'guide/providers.md',
    label: '配置模型',
    sidebar: 'zh-guide',
    section: '入门',
    order: 2,
  }),
  zhPage({
    source: 'docs/user/guide/python-sdk.md',
    route: 'guide/python-sdk.md',
    label: 'Python',
    sidebar: 'zh-guide',
    section: 'SDK',
    order: 1,
  }),
]

const develop: DocsPage[] = [
  zhPage({
    source: 'docs/user/develop/basic/index.md',
    route: 'develop/basic/index.md',
    label: '第一个 Harness 插件',
    sidebar: 'zh-develop',
    section: '基础',
    order: 1,
    sourceAliases: ['docs/user/develop/basic'],
  }),
  zhPage({
    source: 'docs/user/develop/basic/tool.md',
    route: 'develop/basic/tool.md',
    label: '开发一个 Tool',
    sidebar: 'zh-develop',
    section: '基础',
    order: 2,
  }),
  zhPage({
    source: 'docs/user/develop/basic/config.md',
    route: 'develop/basic/config.md',
    label: '插件配置',
    sidebar: 'zh-develop',
    section: '基础',
    order: 3,
  }),
  zhPage({
    source: 'docs/user/develop/basic/publish.md',
    route: 'develop/basic/publish.md',
    label: '打包与安装插件',
    sidebar: 'zh-develop',
    section: '基础',
    order: 4,
  }),
  zhPage({
    source: 'docs/user/develop/framework/index.md',
    route: 'develop/framework/index.md',
    label: '插件与生命周期',
    sidebar: 'zh-develop',
    section: '框架能力',
    order: 1,
    sourceAliases: ['docs/user/develop/framework'],
  }),
  zhPage({
    source: 'docs/user/develop/framework/service.md',
    route: 'develop/framework/service.md',
    label: '服务与依赖',
    sidebar: 'zh-develop',
    section: '框架能力',
    order: 2,
  }),
  zhPage({
    source: 'docs/user/develop/framework/events.md',
    route: 'develop/framework/events.md',
    label: '事件系统',
    sidebar: 'zh-develop',
    section: '框架能力',
    order: 3,
  }),
  zhPage({
    source: 'docs/user/develop/practice/index.md',
    route: 'develop/practice/index.md',
    label: '能力的三层拆分',
    sidebar: 'zh-develop',
    section: '实战',
    order: 1,
    sourceAliases: ['docs/user/develop/practice'],
  }),
  zhPage({
    source: 'docs/user/develop/practice/llm-adapter.md',
    route: 'develop/practice/llm-adapter.md',
    label: 'LLM 适配器',
    sidebar: 'zh-develop',
    section: '实战',
    order: 2,
  }),
]

const cordisTutorial: DocsPage[] = ([
  ['index.md', '总览'],
  ['01-first-plugin.md', '1. 第一个插件'],
  ['02-lifecycle-and-effects.md', '2. 生命周期与副作用'],
  ['03-services.md', '3. 服务'],
  ['04-events.md', '4. 事件'],
  ['05-config.md', '5. 配置'],
  ['06-composition-and-hmr.md', '6. 组合与热重载'],
  ['07-into-the-harness.md', '7. 进入 Harness'],
] as const).map(([file, label], order) => zhPage({
  source: `docs/cordis-tutorial/${file}`,
  route: `develop/cordis-tutorial/${file}`,
  label,
  sidebar: 'zh-develop',
  section: 'Cordis 框架教程',
  order,
  ...(file === 'index.md' ? { sourceAliases: ['docs/cordis-tutorial'] } : {}),
}))

const cordisPrimerReference: DocsPage[] = [
  zhPage({
    source: 'docs/cordis-primer.md',
    route: 'reference/cordis-primer.md',
    label: 'Cordis 入门',
    sidebar: 'zh-reference',
    section: '概念',
    order: 1,
  }),
]

/**
 * 按主题分组的子系统页面，形如 `[分组, 页面]`。单一平铺清单会把参考
 * 侧边栏的其余分组挤出首屏。
 */
const subsystemGroups = [
  ['总览', [
    ['README.md', '子系统'],
  ]],
  ['内核与作用域', [
    ['core.md', '核心'],
    ['scope.md', '作用域'],
    ['invariants.md', '运行时不变式'],
  ]],
  ['会话与持久化', [
    ['session.md', '会话'],
    ['session-query.md', '会话查询'],
    ['session-reference.md', '会话引用'],
    ['session-title.md', '会话标题'],
    ['session-projection.md', '会话投影'],
    ['persistence.md', '会话持久化'],
    ['spill.md', 'Spill 存储'],
    ['session-telemetry.md', '遥测'],
  ]],
  ['模型与上下文', [
    ['llm-streaming.md', 'LLM 流式响应'],
    ['token-meter.md', 'Token 计量'],
    ['system-prompt.md', '系统提示词'],
    ['compaction.md', '上下文压缩'],
  ]],
  ['执行与工具', [
    ['tools.md', '工具'],
    ['shell.md', 'Bash 执行'],
    ['subprocess.md', '子进程'],
    ['terminal.md', 'PTY 会话'],
    ['jobs.md', '后台任务'],
    ['filesystem.md', '文件系统'],
    ['lsp.md', 'LSP 导航'],
    ['code-runtime.md', '代码运行时'],
    ['web.md', 'Web 访问'],
    ['skills.md', '技能'],
    ['workflow.md', '工作流'],
    ['subagent.md', '子代理'],
  ]],
  ['策略与交互', [
    ['approval.md', '审批'],
    ['permission-presets.md', '权限预设'],
    ['sandbox.md', '沙箱'],
    ['plan.md', '计划模式'],
    ['user-questions.md', '用户交互'],
    ['commands.md', '命令'],
    ['goal.md', '目标'],
    ['schedule.md', '定时提醒'],
  ]],
  ['平台与接入', [
    ['web-server.md', 'HTTP 服务器'],
    ['typert.md', 'Typert'],
    ['client-modules.md', '客户端模块'],
    ['storage.md', '存储'],
    ['workspace.md', '工作区'],
    ['settings.md', '用户设置'],
    ['credentials.md', '用户凭据'],
  ]],
] as const

const subsystemsReference: DocsPage[] = subsystemGroups.flatMap(([section, files]) => files.map(([file, label], order) => zhPage({
  source: `docs/subsystems/${file}`,
  route: file === 'README.md' ? 'reference/subsystems/index.md' : `reference/subsystems/${file}`,
  label,
  sidebar: 'zh-reference',
  section,
  order,
  // 子系统页面带有很长的三级小节，两级大纲才能覆盖。
  outline: [2, 3],
  ...(file === 'README.md' ? { sourceAliases: ['docs/subsystems'] } : {}),
})))

const reference: DocsPage[] = [
  zhPage({
    source: 'docs/architecture.md',
    route: 'reference/index.md',
    label: '架构',
    sidebar: 'zh-reference',
    section: '概念',
    order: 0,
  }),
  zhPage({
    source: 'docs/capability-seams.md',
    route: 'reference/capability-seams.md',
    label: '能力服务',
    sidebar: 'zh-reference',
    section: '概念',
    order: 2,
  }),
  zhPage({
    source: 'docs/agent-lifecycle.md',
    route: 'reference/agent-lifecycle.md',
    label: 'Agent 生命周期',
    sidebar: 'zh-reference',
    section: '概念',
    order: 3,
  }),
  zhPage({
    source: 'docs/tool-execution-pipeline.md',
    route: 'reference/tool-execution-pipeline.md',
    label: 'Tool 执行',
    sidebar: 'zh-reference',
    section: '概念',
    order: 4,
  }),
  zhPage({
    source: 'docs/config-catalog.md',
    route: 'reference/config-catalog.md',
    label: '插件配置',
    sidebar: 'zh-reference',
    section: '生成参考',
    order: 0,
  }),
  zhPage({
    source: 'docs/tool-catalog.md',
    route: 'reference/tool-catalog.md',
    label: 'Tool Schema',
    sidebar: 'zh-reference',
    section: '生成参考',
    order: 1,
  }),
  zhPage({
    source: 'docs/persistence-catalog.md',
    route: 'reference/persistence-catalog.md',
    label: '持久化事件',
    sidebar: 'zh-reference',
    section: '生成参考',
    order: 2,
    outline: 'deep',
  }),
  ...([
    ['context.md', 'Context'],
    ['events.md', 'Events'],
    ['fiber.md', 'Fiber'],
    ['registry.md', 'Plugin Registry'],
    ['service.md', 'Service'],
  ] as const).map(([file, label], order) => zhPage({
    source: `docs/cordis-api/${file}`,
    route: `reference/cordis-api/${file}`,
    label,
    sidebar: 'zh-reference',
    section: 'Cordis API',
    order,
  })),
  zhPage({
    source: 'docs/cordis-api/inherited.md',
    route: 'reference/cordis-api/inherited.md',
    label: '继承接口面',
    sidebar: 'zh-reference',
    section: 'Cordis API',
    order: 5,
    contentLocale: 'en-US',
  }),
  zhPage({
    source: 'docs/cookbook/adding-a-package.md',
    route: 'reference/cookbook/adding-a-package.md',
    label: '新增 Package',
    sidebar: 'zh-reference',
    section: '开发手册',
    order: 0,
  }),
  zhPage({
    source: 'docs/cookbook/adding-a-tool.md',
    route: 'reference/cookbook/adding-a-tool.md',
    label: '新增 Tool',
    sidebar: 'zh-reference',
    section: '开发手册',
    order: 1,
  }),
  zhPage({
    source: 'docs/cookbook/adding-an-llm-adapter.md',
    route: 'reference/cookbook/adding-an-llm-adapter.md',
    label: '新增 LLM Adapter',
    sidebar: 'zh-reference',
    section: '开发手册',
    order: 2,
  }),
  zhPage({
    source: 'docs/cookbook/adding-a-settings-card.md',
    route: 'reference/cookbook/adding-a-settings-card.md',
    label: '新增设置卡片',
    sidebar: 'zh-reference',
    section: '开发手册',
    order: 3,
  }),
  zhPage({
    source: 'docs/cookbook/extension-cookbook.md',
    route: 'reference/cookbook/extension-cookbook.md',
    label: '扩展模式',
    sidebar: 'zh-reference',
    section: '开发手册',
    order: 4,
  }),
  zhPage({
    source: 'docs/cookbook/adding-a-conversation-node.md',
    route: 'reference/cookbook/adding-a-conversation-node.md',
    label: '新增 Conversation Node',
    sidebar: 'zh-reference',
    section: '开发手册',
    order: 5,
  }),
]

/** A sidebar group, matched to pages by `label`. */
export interface DocsSection {
  /** Group heading, equal to the `section` field of every page it holds. */
  label: string
  /** Render the group collapsed until it holds the page being read. */
  collapsed?: boolean
}

/**
 * 全部侧边栏分组及其渲染顺序。
 *
 * 子系统各分组默认折叠：它们合计的条目数超过参考侧边栏的其余分组，
 * 全部展开时会把其他分组挤出首屏。
 */
const sections: Record<DocsLocale, readonly DocsSection[]> = {
  root: [
    { label: '入门' }, { label: 'SDK' },
    { label: '基础' }, { label: '框架能力' }, { label: '实战' }, { label: 'Cordis 框架教程' },
    { label: '概念' }, { label: '生成参考' }, { label: 'Cordis API' }, { label: '开发手册' },
    { label: '总览' },
    { label: '内核与作用域', collapsed: true },
    { label: '会话与持久化', collapsed: true },
    { label: '模型与上下文', collapsed: true },
    { label: '执行与工具', collapsed: true },
    { label: '策略与交互', collapsed: true },
    { label: '平台与接入', collapsed: true },
  ],
}

/**
 * 读取一个侧边栏分组的位置与折叠行为。
 *
 * @param locale - 拥有该侧边栏的 locale，恒为 `root`。
 * @param label - 分组内各页面携带的 `section` 标签。
 * @returns 声明的分组及其在 locale 内的零基位置。
 * @throws 当该 locale 没有为此标签声明位置时抛出。仅按列表成员排序会把
 *   未声明的分组静默排到所有已声明分组之前。
 */
export function sectionSpec(locale: DocsLocale, label: string): DocsSection & { index: number } {
  const declared = sections[locale]
  const section = declared.find(candidate => candidate.label === label)
  if (section === undefined) throw new Error(`Sidebar section "${label}" has no placement in the ${locale} locale.`)
  return { ...section, index: declared.indexOf(section) }
}

/** Every canonical page published by the documentation website. */
export const docsPages: DocsPage[] = [
  ...homeAndGuide,
  ...develop,
  ...cordisTutorial,
  ...cordisPrimerReference,
  ...subsystemsReference,
  ...reference,
]

/**
 * 读取一个侧边栏集合的页面，按侧边栏列出的顺序。
 *
 * @param locale - 拥有该侧边栏的 locale，恒为 `root`。
 * @param collection - 要读取的侧边栏集合。
 * @returns 该集合的页面，先按分组位置、再按 `order` 排序。
 */
export function orderedPages(locale: DocsLocale, collection: DocsSidebar): DocsPage[] {
  return docsPages
    // 单语言站点：每个页面都投影到 `root`，因此不需要按 locale 过滤。
    .filter(page => page.sidebar === collection)
    .sort((left, right) => (
      sectionSpec(locale, left.section).index - sectionSpec(locale, right.section).index
      || left.order - right.order
    ))
}

/**
 * Site-relative link for a published route.
 *
 * @param route - Manifest route, including its `.md` suffix.
 * @returns The link VitePress serves the route at.
 */
export function routeLink(route: string): string {
  return `/${route.replace(/(?:index)?\.md$/, '')}`
}

/**
 * 顶层导航项的落点。
 *
 * 落点是推导出来的而不是手写的：集合首页被改名或重排后，手写值会让
 * 导航栏指向清单已不再发布的路由。
 *
 * @param locale - 导航项所属的 locale，恒为 `root`。
 * @param collection - 导航项打开的侧边栏集合。
 * @returns 该集合第一页的站内相对链接。
 * @throws 当该集合没有发布任何页面时抛出。
 */
export function landingLink(locale: DocsLocale, collection: DocsSidebar): string {
  const first = orderedPages(locale, collection)[0]
  if (first === undefined) throw new Error(`Sidebar collection "${collection}" publishes no page.`)
  return routeLink(first.route)
}
