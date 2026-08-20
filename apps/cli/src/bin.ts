#!/usr/bin/env node
/**
 * dsh — command-line entry. Dynamic imports per mode keep unrelated modes out
 * of each dispatch path; the adapter prints and exits for
 * `--help`/`--version`/a parse error, so only a valid mode reaches the switch.
 * @module @deepseek-ai/dsh/bin
 */

/* v8 ignore file -- built-bin acceptance exercises this self-executing dispatch. */

import { chdir } from 'node:process'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadLayeredEnv } from '@deepseek-ai/dsh-app-boot'
import { parseDshArgs } from './args.ts'

// Both the source tree (apps/cli/src) and the bundled bin (apps/cli/lib) sit
// one directory under apps/cli, so the checked-in manifest resolves with the
// same relative hop from either artifact.
/** This app's version, read from its checked-in package.json. */
function readVersion(): string {
  const manifest = JSON.parse(
    readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'),
  ) as { version?: unknown }
  return typeof manifest.version === 'string' ? manifest.version : '0.0.0'
}

const version = process.env.DSH_APP_VERSION ?? readVersion()
// Every profile uses the same app package version. The managed Coding Host
// publishes it in its local discovery record and host.describe response.
process.env.DSH_APP_VERSION = version
// Native launchers keep the Node module working directory at the installed
// runtime root and pass the user's project directory through this private
// environment variable. Changing it before the profile is composed makes the
// existing ApiProxy default cwd and host.describe.cwd agree with --cwd.
const managedCwd = process.env.DSH_CWD
if (managedCwd !== undefined && managedCwd.trim() !== '') {
  try {
    chdir(resolve(managedCwd))
  } catch (error) {
    console.error(`coding host: cannot use DSH_CWD ${JSON.stringify(managedCwd)}: ${String(error)}`)
    process.exit(1)
  }
}
const invocation = parseDshArgs(process.argv.slice(2), version)

switch (invocation.mode) {
  case 'profile': {
    const { runProfile } = await import('./profile-boot.ts')
    await runProfile({
      environment: loadLayeredEnv('dsh'),
      profile: invocation.profile,
      patchFiles: invocation.patches,
      args: invocation.args,
    })
    break
  }
  case 'plugin': {
    const { runPlugin } = await import('./plugin.ts')
    process.exit(runPlugin(invocation.profile, invocation.args))
    break
  }
  case 'dump-config': {
    const { runDumpConfig } = await import('./dump-config.ts')
    runDumpConfig(invocation.profile, invocation.defaultOnly, invocation.patches)
    break
  }
  default:
    invocation satisfies never
    throw new Error(`dsh: unhandled invocation mode ${JSON.stringify(invocation)}`)
}
