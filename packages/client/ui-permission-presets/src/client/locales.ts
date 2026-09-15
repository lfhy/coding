/** `settings.permission` 命名空间词典，即权限设置行持有的副本。 */

/** 简体中文词典，也是键集合真源。 */
export const zh = {
  'title': '权限',
  'description': '选择新会话的默认权限模式',
  'loading': '加载中',
  'unavailable': '不可用',
  'preset.readOnly': '只读',
  'preset.workspaceWrite': '工作区写入',
  'preset.fullAccess': '完全访问',
  'preset.custom': '自定义',
  'confirm.title': '确认启用完全访问？',
  'confirm.description': '启用完全访问后，新会话将减少确认步骤，并且可以直接执行更多操作，包括敏感操作、文件修改或外部命令。仅建议在你信任后续任务时使用。',
  'confirm.acknowledge': '我已了解风险，并愿意继续',
  'confirm.close': '关闭',
  'confirm.cancel': '取消',
  'confirm.enable': '启用完全访问',
} satisfies Record<string, string>

/** settings.permission 命名空间键联合。 */
export type PermissionSettingsKey = keyof typeof zh

/** 英文词典，按中文键集合检查完整性。 */
export const en = {
  'title': 'Permission',
  'description': 'Choose the default permission mode for new sessions',
  'loading': 'Loading',
  'unavailable': 'Unavailable',
  'preset.readOnly': 'Read Only',
  'preset.workspaceWrite': 'Workspace Write',
  'preset.fullAccess': 'Full access',
  'preset.custom': 'Custom',
  'confirm.title': 'Enable Full access?',
  'confirm.description': 'Full access lets new sessions reduce confirmation steps and perform more actions directly, including sensitive operations, file changes, or external commands. Only use it when you trust subsequent tasks.',
  'confirm.acknowledge': 'I understand the risks and want to continue',
  'confirm.close': 'Close',
  'confirm.cancel': 'Cancel',
  'confirm.enable': 'Enable Full access',
} satisfies Record<PermissionSettingsKey, string>

/** 当前会话 popup 门控使用的简体中文词典。 */
export const accessZh = {
  'preset.readOnly': '只读',
  'preset.workspaceWrite': '工作区写入',
  'preset.fullAccess': '完全访问',
  'preset.custom': '自定义',
  'confirm.title': '确认启用完全访问？',
  'confirm.description': '启用完全访问后，智能体将减少确认步骤，并且可以直接执行更多操作，包括敏感操作、文件修改或外部命令。仅建议在你信任当前任务时使用。',
  'confirm.acknowledge': '我已了解风险，并愿意继续',
  'confirm.close': '关闭',
  'confirm.cancel': '取消',
  'confirm.enable': '启用完全访问',
} satisfies Record<string, string>

/** 当前会话 popup 门控键联合。 */
export type PermissionAccessKey = keyof typeof accessZh

/** 当前会话 popup 门控使用的英文词典。 */
export const accessEn = {
  'preset.readOnly': 'Read Only',
  'preset.workspaceWrite': 'Workspace Write',
  'preset.fullAccess': 'Full access',
  'preset.custom': 'Custom',
  'confirm.title': 'Enable Full access?',
  'confirm.description': 'Full access reduces confirmation steps and lets the agent perform more actions directly, including sensitive operations, file changes, or external commands. Only use it when you trust the current task.',
  'confirm.acknowledge': 'I understand the risks and want to continue',
  'confirm.close': 'Close',
  'confirm.cancel': 'Cancel',
  'confirm.enable': 'Enable Full access',
} satisfies Record<PermissionAccessKey, string>
