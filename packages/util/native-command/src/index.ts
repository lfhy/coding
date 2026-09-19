/**
 * 宿主原生命令执行与路径打开工具。
 * @module @deepseek-ai/dsh-native-command
 */

export { runNativeCommand } from './runner.ts'
export type { NativeCommandRunner } from './runner.ts'
export { canOpenNativePath, openNativePath, openNativeTextFile } from './path-opener.ts'
export type { PathOpenerInternals, PathOpenerRunner } from './path-opener.ts'
