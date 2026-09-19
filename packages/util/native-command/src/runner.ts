/**
 * 运行宿主原生命令的无 Shell 边界：捕获 UTF-8 标准流、传递取消，并隐藏 Windows 控制台窗口。
 * @module @deepseek-ai/dsh-native-command/runner
 */

import { execFile } from 'node:child_process'

/** 可测试的命令边界；原生集成绝不经由 Shell。 */
export type NativeCommandRunner = (
  command: string,
  args: readonly string[],
  signal: AbortSignal,
) => Promise<{ stdout: string; stderr: string }>

/**
 * 运行宿主命令并捕获 UTF-8 标准流，同时传递取消且隐藏 Windows 控制台窗口。
 * @param command - 可执行文件路径或 PATH 名称。
 * @param args - 参数数组，绝不接受 Shell 字符串。
 * @param signal - 调用方生命周期；取消时终止子进程。
 * @returns 退出码为 0 时捕获到的标准输出和标准错误。
 */
export const runNativeCommand: NativeCommandRunner = (command, args, signal) =>
  new Promise((resolve, reject) => {
    execFile(
      command,
      [...args],
      { encoding: 'utf8', signal, windowsHide: true },
      (error, stdout, stderr) => {
        if (error !== null) {
          const failure = Object.assign(new Error(error.message, { cause: error }), {
            code: error.code,
            stdout,
            stderr,
          })
          reject(failure)
          return
        }
        resolve({ stdout, stderr })
      },
    )
  })
