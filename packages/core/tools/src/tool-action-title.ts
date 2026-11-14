import { toolDisplayDescription } from './display-description-value.ts'

/** 已知模型工具的用户可见动作标题，供对话和轨迹共用。未知动作由各视图回退。 */
const ACTION_TITLES: Readonly<Record<string, string>> = {
  apply_patch: 'Apply patch',
  str_replace_editor: 'Edit file',
  read_image: 'Read image',
  write_stdin: '查看后台任务输出',
  update_plan: 'Update plan',
  todo_write: 'Update plan',
  set_status: '更新当前进度',
  skill: 'Load skill',
  skill_read: 'Read skill',
  context_compact: 'Compact context',
  memory_list: 'List memory',
  memory_read: 'Read memory',
  memory_save: 'Save memory',
  memory_update: 'Update memory',
  memory_delete: 'Delete memory',
  list_subagent_models: 'Browse models',
  spawn_agent: 'Delegate task',
  subagent: 'Delegate task',
  subagent_fork: 'Delegate task',
  followup_task: '安排子代理后续任务',
  send_message: '向子代理发送消息',
  list_agents: 'List agents',
  wait_agent: 'Wait for agents',
  interrupt_agent: 'Stop agent',
  report: 'Report result',
  create_goal: 'Create goal',
  get_goal: 'Read goal',
  update_goal: 'Update goal',
  job_output: 'Read job output',
  job_list: 'List jobs',
  job_kill: 'Stop job',
  workflow: 'Run workflow',
  ralph: 'Continue task',
  validate_gen_ui: '校验UI语法',
  cordis_inspect_list: 'Browse plugin capabilities',
  terminal_list: 'List terminals',
  canvas_state: 'View canvas',
  cordis_package_inspect: 'Inspect',
  cordis_runtime_inspect: 'Inspect',
  cordis_run: 'Run Cordis Plugin',
  cordis_stop: 'Stop Cordis Plugin',
  cordis_undefine: 'Remove Cordis Plugin',
  pwsh: 'Pwsh',
  ask_user_question: 'Ask question',
  bash: 'Bash',
  exec_command: 'Bash',
  run_code: 'Code',
  read: 'Read',
  write: 'Write',
  edit: 'Edit',
  grep: 'Search',
  glob: 'Search',
  web_search: 'Search',
  web_fetch: 'Read',
  render_ui: '展示交互卡片',
  cordis_define: '创建插件',
  cordis_inspect_query: '查询插件能力',
  cordis_inspect_self: '查看插件信息',
  team_task_create: '创建团队任务',
  team_task_get: '查看团队任务',
  team_task_list: '查看团队任务',
  team_task_update: '更新团队任务',
  spawn_teammate: '委派团队成员',
  browser_act: '操作网页',
  browser_auth_flush: '保存浏览器登录状态',
  browser_captcha: '检查人机验证',
  browser_cdp: '执行浏览器调试操作',
  browser_check: '勾选网页选项',
  browser_cli: '运行浏览器脚本',
  browser_click: '点击网页元素',
  browser_close: '关闭浏览器',
  browser_dialog: '处理网页弹窗',
  browser_doctor: '检查浏览器环境',
  browser_download: '下载网页文件',
  browser_drag: '拖动网页元素',
  browser_fill: '填写网页字段',
  browser_help: '查看浏览器帮助',
  browser_hover: '悬停网页元素',
  browser_http: '发送网页请求',
  browser_js: '执行网页脚本',
  browser_key: '按下网页按键',
  browser_login_import: '导入浏览器登录状态',
  browser_navigate: '打开网页',
  browser_page_info: '查看网页信息',
  browser_read_element: '读取网页元素',
  browser_screenshot: '截取网页画面',
  browser_script: '运行浏览器脚本',
  browser_scroll: '滚动网页',
  browser_select: '选择网页选项',
  browser_snapshot: '查看网页',
  browser_space_close: '关闭浏览器空间',
  browser_space_open: '打开浏览器空间',
  browser_status: '查看浏览器状态',
  browser_tabs: '管理浏览器标签页',
  browser_upload: '上传网页文件',
  browser_viewport: '调整网页视口',
  browser_wait: '等待网页',
  browser_wait_for_human: '等待人工操作',
  browser_wait_for_response: '等待网页响应',
  browser_wait_for_selector: '等待网页元素',
  browser_wait_for_url: '等待网页跳转',
  computer_click: '点击应用',
  computer_confirm: '确认敏感操作',
  computer_drag: '拖动应用内容',
  computer_list_apps: '查看应用列表',
  computer_observe: '观察应用',
  computer_perform_action: '执行应用操作',
  computer_press_key: '按下应用按键',
  computer_scroll: '滚动应用',
  computer_set_value: '设置应用字段',
  computer_type_text: '在应用中输入',
  computer_use_activate: '启用电脑操作',
  computer_wait: '等待应用状态',
  edit_image: '编辑图片',
  exit_plan_mode: '提交计划供审阅',
  generate_image: '生成图片',
  generate_images: '批量生成图片',
  image_gen: '生成或编辑图片',
  lsp: '查询代码定义与引用',
  ppt_attach_gallery_image: '添加图库图片',
  ppt_check: '检查演示文稿',
  ppt_create: '创建演示文稿',
  ppt_create_from_template: '从模板创建演示文稿',
  ppt_delete_template: '删除演示模板',
  ppt_edit: '编辑演示文稿',
  ppt_export: '导出演示文稿',
  ppt_import: '导入演示文稿',
  ppt_import_evidence: '导入演示资料',
  ppt_import_template: '导入演示模板',
  ppt_open: '打开演示文稿',
  ppt_prepare_template: '准备演示模板',
  ppt_read: '读取演示文稿',
  ppt_redo: '重做演示文稿编辑',
  ppt_rename_template: '重命名演示模板',
  ppt_render: '渲染演示页面',
  ppt_save_template: '保存演示模板',
  ppt_templates: '浏览演示模板',
  ppt_undo: '撤销演示文稿编辑',
  schedule_create: '创建提醒',
  schedule_delete: '删除提醒',
  schedule_list: '查看提醒',
  session_event_read: '读取会话事件',
  session_event_search: '搜索会话事件',
  session_event_trace: '追踪会话事件',
  session_search: '搜索历史会话',
  session_trace: '查看会话关系',
  terminal_close: '关闭终端',
  terminal_open: '打开终端',
  terminal_read: '读取终端输出',
  terminal_send: '发送终端输入',
  terminal_signal: '发送终端信号',
}

/** 未知名称仅按已知领域给出类别；调用日志可能来自比当前目录更新的插件。 */
const DOMAIN_TITLES: Readonly<Record<string, string>> = {
  browser: '浏览器操作',
  computer: '电脑操作',
  ppt: '演示文稿操作',
  schedule: '提醒操作',
}

/**
 * 为已知调用提供动作标题，未知同领域动作仅显示所属类别。
 * @param name - 会话记录中的工具名。
 * @param argsRaw - 可选的完整调用参数；用于区分后台读取、等待与输入。
 * @returns 可供对话及轨迹使用的标题；未知工具返回 undefined。
 */
export function toolActionTitle(name: string, argsRaw?: string): string | undefined {
  if (name === 'write_stdin' && argsRaw !== undefined) {
    try {
      const args: unknown = JSON.parse(argsRaw)
      if (typeof args === 'object' && args !== null && !Array.isArray(args)) {
        const record = args as Record<string, unknown>
        if (typeof record.chars === 'string' && record.chars !== '') {
          return record.chars.includes('\u0003') || record.chars.includes('\\u0003')
            ? '停止后台任务' : '向后台任务输入'
        }
        return record.yield_time_ms === 0 ? '读取后台任务输出' : '等待后台任务输出'
      }
    } catch {
      // 流式调用尚未形成完整参数时，保持静态动作标题。
    }
  }
  if (Object.hasOwn(ACTION_TITLES, name)) return ACTION_TITLES[name]
  const prefix = name.split('_', 1)[0] ?? ''
  return Object.hasOwn(DOMAIN_TITLES, prefix) ? DOMAIN_TITLES[prefix] : undefined
}

/**
 * 只提取有明确用户可读含义的对象；脚本、补丁正文和不认识的参数留在调用详情。
 * @param name - 会话记录中的工具名。
 * @param argsRaw - 已持久化的调用参数；未闭合时不显示预览。
 * @returns 折叠行可用的对象，或 undefined。
 */
export function toolArgsPreview(name: string, argsRaw: string): string | undefined {
  try {
    const args: unknown = JSON.parse(argsRaw)
    if (typeof args !== 'object' || args === null || Array.isArray(args)) return undefined
    const record = args as Record<string, unknown>
    if (name === 'apply_patch') {
      if (typeof record.input !== 'string') return undefined
      const targets = [...record.input.matchAll(/^\*\*\* (?:Add File|Update File): ([^\r\n]+)\r?$/gm)]
        .map(match => match[1]?.trim()).filter((path): path is string => !!path)
      return targets.length > 1 ? `${targets[0]} 等 ${targets.length} 个文件` : targets[0]
    }
    const keys = name === 'browser_click' ? ['label']
      : name === 'browser_navigate' || name === 'web_fetch' ? ['url']
        : name === 'browser_js' ? []
          : name === 'lsp' ? ['file_path']
            : name === 'str_replace_editor' || name === 'read' || name === 'write' || name === 'edit' || name === 'read_image'
              ? ['path', 'file_path'] : []
    for (const key of keys) {
      const value = record[key]
      if (typeof value === 'string' && value.trim() !== '') return value.split(/[\r\n]/, 1)[0]
    }
    return undefined
  } catch {
    return undefined
  }
}

/**
 * 已有动作说明优先保留；补丁调用仍把目标放在最前，避免较长说明遮住文件。
 * @param name - 会话记录中的工具名。
 * @param argsRaw - 已持久化的调用参数。
 * @param description - 已有的逐次友好说明。
 * @returns 折叠行可用的说明，或 undefined。
 */
export function toolCallPreview(name: string, argsRaw: string, description?: string): string | undefined {
  const target = toolArgsPreview(name, argsRaw)
  if (name === 'apply_patch' && target !== undefined) return description === undefined ? target : `${target} · ${description}`
  return description ?? target
}

/**
 * 从后台任务启动回执提取其身份，拒绝普通输出中的误报和未结算的启动调用。
 * @param name - 启动后台任务的工具名。
 * @param argsRaw - 启动调用参数。
 * @param output - 启动回执的完整模型可见文本。
 * @returns 后台任务身份与逐次说明；缺少说明时不推断命令用途。
 */
export function backgroundStart(name: string, argsRaw: string, output: string): { id: string; description: string } | undefined {
  if (name !== 'bash' && name !== 'exec_command') return undefined
  const id = /^started background job (\S+)$/.exec(output)?.[1]
  if (id === undefined) return undefined
  try {
    const args: unknown = JSON.parse(argsRaw)
    if (typeof args !== 'object' || args === null || Array.isArray(args)) return undefined
    const record = args as Record<string, unknown>
    if (record.run_in_background !== true) return undefined
    const description = toolDisplayDescription(args, name)
    return description === undefined ? undefined : { id, description }
  } catch {
    return undefined
  }
}

/**
 * 读取后台会话所指的任务身份；不把缺失、未闭合或其他工具参数当作任务索引。
 * @param name - 工具名。
 * @param argsRaw - 会话控制调用参数。
 * @returns 匹配后台启动回执的身份，或 undefined。
 */
export function backgroundSessionId(name: string, argsRaw: string): string | undefined {
  if (name !== 'write_stdin') return undefined
  try {
    const args: unknown = JSON.parse(argsRaw)
    if (typeof args !== 'object' || args === null || Array.isArray(args)) return undefined
    const id = (args as Record<string, unknown>).session_id
    return typeof id === 'string' && id !== '' ? id : undefined
  } catch {
    return undefined
  }
}

/**
 * 只给后台控制和子代理通信提供回执摘要，不把命令输出或消息正文当作行标题。
 * @param name - 会话记录中的工具名。
 * @param output - 已结算的模型可见结果文本。
 * @param isError - 调用是否失败；失败并不证明子代理没有收到消息。
 * @returns 面向用户的状态说明；其他工具不接管已有结果展示。
 */
export function toolResultPreview(name: string, output: string, isError: boolean): string | undefined {
  if (name === 'send_message' || name === 'followup_task') {
    if (isError) return '未能确认消息是否送达，请查看详情'
    const delivery = name === 'send_message' ? 'next-step' : 'next-turn'
    return new RegExp(`^message accepted for ${delivery} delivery to subagent [^\\r\\n]+$`).test(output)
      ? name === 'send_message' ? '消息已接受，等待处理' : '后续任务已安排，等待执行'
      : '消息状态未确认，请查看详情'
  }
  if (name !== 'write_stdin') return undefined
  if (isError) return '读取后台任务失败，请查看详情'
  const status = /\[status: (running|stopping|completed|killed|failed)(?:,[^\]\r\n]*)?\]\s*$/.exec(output)?.[1]
  switch (status) {
    case 'running': return '任务仍在运行'
    case 'stopping': return '任务正在停止'
    case 'completed': return '任务已结束，结果见详情'
    case 'killed': return '任务已停止'
    case 'failed': return '任务运行失败，请查看详情'
    default: return '任务状态未确认，请查看详情'
  }
}
