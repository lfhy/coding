/**
 * Package-owned invariant companion for `coding-tool-context-compact`.
 * @module coding-tool-context-compact/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from 'coding-invariants'

const PACKAGE_NAME = 'coding-tool-context-compact'

/** Cordis companion plugin name. */
export const name = 'tool-context-compact-invariant'
/** Services required before the companion can register. */
export const inject = ['invariants']

/**
 * No runtime invariant: this tool owns no state or event stream; the compaction
 * seam owns the balanced durable transaction and the tool registry owns
 * registration and dispatch lifecycle.
 */
const install: InvariantInstaller = () => {}

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
