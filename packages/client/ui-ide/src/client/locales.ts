/** 代码工作区入口文案键。 */
export const NS = 'ide'

export type IdeLocaleKey =
  | 'nav' | 'title' | 'headline' | 'description' | 'openFolder'
  | 'recent' | 'empty' | 'loading' | 'error' | 'entryError' | 'workspaceError'

/** 简体中文文案。 */
export const zh: Record<IdeLocaleKey, string> = {
  nav: '代码工作区', title: '代码工作区', headline: '打开一个项目开始编码',
  description: '选择最近的工作区，或者从本机文件夹打开新项目。',
  openFolder: '打开文件夹', recent: '最近打开', empty: '还没有工作区，先打开一个文件夹。',
  loading: '正在读取工作区…', error: '无法读取工作区，请稍后重试。',
  entryError: '无法打开代码工作区，请重试。', workspaceError: '无法打开工作区，请重试。',
}

/** 英文文案。 */
export const en: Record<IdeLocaleKey, string> = {
  nav: 'Code', title: 'Code workspace', headline: 'Open a project and start coding',
  description: 'Choose a recent workspace or open a new project from a local folder.',
  openFolder: 'Open folder', recent: 'Recent', empty: 'No workspaces yet. Open a folder to get started.',
  loading: 'Loading workspaces…', error: 'Could not load workspaces. Try again later.',
  entryError: 'Could not open the code workspace. Try again.', workspaceError: 'Could not open the workspace. Try again.',
}
