/**
 * The web app's command-line provider: it parses the `dsh --profile web` flag
 * family (`--host`, `--port`, `--trusted-host`, `--no-open`) and its `--help`
 * text, then provides the immutable values as {@link WEB_STARTUP_SERVICE}.
 * Ordinary rows inject that service before reading it from lazy config.
 * @module @deepseek-ai/dsh-web-app/startup
 */

import { Command } from 'commander'
import type { Context } from '@deepseek-ai/cordis'
import { parseCmdline } from '@deepseek-ai/dsh-cmdline'

/** Stable Cordis plugin name. */
export const name = 'web-startup'

/** Services required before the flags can be resolved. */
export const inject = ['cmdlineArgs']

/** Service provided by this ordinary plugin and injected by flag-configured rows. */
export const WEB_STARTUP_SERVICE = 'webStartup'

/** What the web rows read from {@link WEB_STARTUP_SERVICE}. */
export interface WebStartupValues {
  /** Whether this invocation opens the default browser after startup. */
  openBrowser: boolean
  /** Whether this invocation prints the human-readable URL line after startup. */
  printUrl: boolean
  /** `--host`, absent when the invocation did not name one. */
  host?: string
  /** `--port`, absent when the invocation did not name one. */
  port?: number
  /** Explicit `--trusted-host` authorities, in argument order. */
  trustedHosts: string[]
  /** Whether a Coding native launcher owns this loopback-only Host process. */
  managedHost: boolean
}

/** The web flag family, as commander parsed it. */
interface WebOptions {
  codingHost?: boolean
  host?: string
  open: boolean
  port?: string
  trustedHost?: string[]
}

/**
 * 创建 Web 应用的命令、参数和帮助文本。
 * @returns 新建的命令对象，供同一进程重复解析（测试使用）。
 */
function webCommand(): Command {
  return new Command()
    .name('dsh --profile web')
    .description('Serve the Coding browser UI.')
    .helpOption('-h, --help', 'show this help')
    .option('--host <host>', 'bind host')
    .option('--coding-host', 'run as the local Host managed by a Coding native client')
    .option('--no-open', 'do not open the Web UI in the default browser')
    .option('--port <port>', 'listen port; pass 0 to let the OS pick a free one')
    .option('--trusted-host <authority...>', 'extra authority the /api browser-trust fence accepts (host or host:port; repeatable)')
    .addHelpText('after', `
Examples:
  dsh --profile web                          serve on the composed host and port
  dsh --profile web --no-open                serve without opening a browser
  dsh --profile web --port 8080              serve on another port
  dsh --profile web --coding-host            serve a Coding native client on an OS-selected loopback port
`)
}

/**
 * Parse and provide the Web invocation as an ordinary Cordis service. The
 * command's action publishes the flags this invocation named; `--host 0.0.0.0`
 * or a non-numeric `--port` is a usage error, so on rejection (and on `--help`)
 * nothing is provided.
 * @param ctx - plugin context carrying the command line.
 */
export function apply(ctx: Context): void {
  const program = webCommand()
  program.action(() => {
    const options = program.opts<WebOptions>()
    if (options.host === '0.0.0.0') {
      program.error('error: --host 0.0.0.0 is intentionally not supported yet for safety: it would expose remote code execution to the network; use 127.0.0.1 instead')
    }
    if (options.port !== undefined && !/^\d+$/.test(options.port)) {
      program.error(`error: --port must be a number, got ${JSON.stringify(options.port)}`)
    }
    if (options.codingHost === true && options.port !== undefined && options.port !== '0') {
      program.error('error: --coding-host only supports --port 0')
    }
    ctx.provide(WEB_STARTUP_SERVICE, {
      openBrowser: options.codingHost === true ? false : options.open,
      printUrl: options.codingHost !== true,
      ...options.codingHost === true
        ? { host: '127.0.0.1' }
        : options.host !== undefined ? { host: options.host } : {},
      ...options.codingHost === true
        ? { port: 0 }
        : options.port !== undefined ? { port: Number(options.port) } : {},
      trustedHosts: options.trustedHost ?? [],
      managedHost: options.codingHost === true,
    } satisfies WebStartupValues)
  })
  parseCmdline(ctx, program)
}
