/**
 * Package-owned invariant companion for `coding-fs-workspace`.
 * @module coding-fs-workspace/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from 'coding-invariants'

const PACKAGE_NAME = 'coding-fs-workspace'

/** Cordis companion plugin name. */
export const name = 'fs-workspace-invariant'
/** Services required before the companion can register. */
export const inject = ['invariants']

/** No runtime invariant: the assembly only registers backends; dispatch relations belong to `coding-fs`. */
const install: InvariantInstaller = () => {}

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
