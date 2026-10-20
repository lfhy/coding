/**
 * Package-owned invariant companion for `coding-session-title-llm`.
 * @module coding-session-title-llm/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from 'coding-invariants'

const PACKAGE_NAME = 'coding-session-title-llm'

/** Cordis companion plugin name. */
export const name = 'session-title-llm-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: this helper installs the title-model settings section and validates each
 * auxiliary request before dispatch; the settings merge, route choice, deadline, stream, and cited
 * message seqs are checked synchronously and by tests.
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
