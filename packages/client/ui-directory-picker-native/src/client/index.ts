/**
 * Browser half of the native directory-picker backend: fills ui-workspace's
 * two directory-flow holes with a renderless occupant that answers each
 * `open` by driving `host.pickDirectory` (the node half's OS chooser) and
 * reporting the one outcome — picked path, cancellation, or failure — back
 * through the owner conversation. Mounting this package therefore composes
 * both sides of the native interaction with one cordis.yml row; no client
 * code branches on a capability kind.
 */
import type { ClientContext } from 'coding-client-runtime/client'
// 仅类型引入：拉入欢迎页与既有工作区入口声明的目录流槽位。
import type {} from 'coding-client-ui-workspace/client'
import type {} from 'coding-client-ui-ide/client'
import type { NativeFlowInjected } from './flow.ts'
import { NativeDirectoryFlow } from './flow.ts'


/** Required services (cordis fiber inject): the slot registry and the wire-facing workspace service. */
export const inject = ['slots', 'workspaces']

/**
 * 注册无界面的原生目录流。工作区入口可能稍后激活或重新声明，
 * 因此通过 `slots.inject()` 等待对应槽位。
 * @param ctx - Client 根 Context。
 */
export function apply(ctx: ClientContext): void {
  const injected = (): NativeFlowInjected => ({ pick: () => ctx.workspaces.pickDirectory() })
  // 两个既有入口的声明必须同时就绪；生成器让这一组注册原子安装或回滚。
  ctx.slots.inject('conversation.hero.workspace.directoryFlow', () =>
    ctx.slots.inject('sidebar.workspaces.directoryFlow', function* () {
      yield ctx.slots.register({
        name: 'conversation.hero.workspace.directoryFlow', inject: injected,
      }, NativeDirectoryFlow)
      yield ctx.slots.register({
        name: 'sidebar.workspaces.directoryFlow', inject: injected,
      }, NativeDirectoryFlow)
    }))
  // 欢迎页是可选入口；它的声明未装载时不能阻塞既有两处工作区入口。
  ctx.slots.inject('shell.ide.welcome.directoryFlow', () => ctx.slots.register({
    name: 'shell.ide.welcome.directoryFlow', inject: injected,
  }, NativeDirectoryFlow))
}
