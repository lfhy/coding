/**
 * Package-owned invariant companion for `coding-proxy-pool`.
 * @module coding-proxy-pool/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from 'coding-invariants'

const PACKAGE_NAME = 'coding-proxy-pool'

/** Cordis companion plugin name. */
export const name = 'proxy-pool-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: registration/disposal and health events are asserted by
 * the package's own specs; no additional cross-event relation needs a reporter.
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
