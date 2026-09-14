# Agent Note: 宿主发起的 goal 暂停中止当前轮次

Status: implemented

[English](2026-09-01-host-goal-pause-aborts-turn.md) | 中文

## 问题

在 Web UI 点击「暂停目标」会把 goal 改成 `paused` 并解除自动续跑的武装（disarmed），但已经在跑的模型轮次不会停止。模型还能继续行动，并在同一个轮次里调用 `update_goal resume`，立刻撤销这次暂停，因此人工暂停对 goal 执行没有真正的控制力。

## 决策

goal round driver 现在会读取每个 `goal/changed` 事件里的 `change`。当 `operation === 'pause'` 时，driver 用 `agent.cancel({ kind: 'user' }, { keepInbox: true })` 中止当前轮次，除非这次暂停是由 agent 自己的轮次发起的。Web 按钮运行在任何 agent initiator 边界之外，而模型调用 `update_goal pause` 时当前 initiator 就是该 agent；driver 用 `ctx.agents.currentInitiator() !== agent` 来区分两者。

`keepInbox` 会保留待处理工作。一旦 goal 被 disarmed，已排队的 goal round 就会在既有的 pre-step reservation 校验里失败，因此暂停后不会再运行。

## 考虑过的替代方案

**对每次暂停都中止轮次，包括模型自己发起的。** 否决：响应人类直接请求而暂停的模型应当完成本轮并给出回复；在工具调用中途中止只会截断这层确认，却换不来更多控制力。

**把中止逻辑放进 goal 服务的 `pause`。** 否决：`pause` 是宿主与模型共用的唯一入口，服务里同样需要这个 initiator 判断。把控制处理留在 round driver，可以让 goal 服务保持为持久状态与事件的拥有者。

## 后果

现在 Web 的「暂停目标」会中止正在运行的轮次，模型无法继续行动或在同一轮次里恢复刚被暂停的 goal。模型发起的暂停行为不变。改动局限于 round driver 及其测试；goal 领域、工具授权与持久化格式都不变。
