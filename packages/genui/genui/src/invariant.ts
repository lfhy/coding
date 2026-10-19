/**
 * Package-owned invariant companion for `coding-genui`.
 * @module coding-genui/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantFailure, InvariantInstaller } from 'coding-invariants'

const PACKAGE_NAME = 'coding-genui'

/** Cordis companion plugin name. */
export const name = 'genui-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: the prompt section, model tools, bundled skill, and
 * asset route are registry-owned registrations whose disposal is proven by the
 * plugin lifecycle. They emit no cordis events and own no cross-plugin mutable
 * state.
 */
const install: InvariantInstaller = Object.assign(
  (ctx: Context, fail: InvariantFailure) => { void ctx; void fail },
  { inject: [] as string[] },
)

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
