# Agent Note: 僵尸 Host 启动锁在启动时被回收

Status: implemented

[English](2026-08-22-zombie-host-launch-lock-reclaim.md) | 中文

## 问题

桌面壳经 `hostlaunch.Ensure` 启动，先取 `~/.dsh/host.lock` 再做发现或拉起。该锁的存活语义只有 `O_EXCL` 创建加关闭时删除：上一次 Coding 或 coding-host 异常退出（崩溃、`kill`、注销）后，锁文件残留并带着已死的属主 PID。之后每次桌面启动都要耗满 30 秒锁超时反复轮询一个无人会释放的文件——启动页全程停在"正在准备 Coding"，超时后才报锁超时错误。

`discover` 早已把死 PID 的 `host.json` 视为缺失；启动锁没有对应的防护。

## 决策

`acquireLock` 现在读取既有锁文件首行作为属主 PID，调用已有的 `processAlive`。属主已死的锁被删除并立即重试获取，崩溃重启的启动由此收回自己的残留锁，而不是等待。存活属主仍按完整超时持有锁；内容缺失或无法解析的锁走原超时路径（无法证明它被遗弃）。

回收方式与桌面单实例 socket 的既有做法同源：检测到残留文件、删除、重试。

## 备选方案

- **改用 flock。** 建议锁在进程死亡时自动释放，但 Windows 孪生实现需要另一套原语，当前跨进程方案刻意共用文件式锁。
- **按锁文件 mtime 过期。** Host 慢启动可能合法超过任何固定时长；属主存活检测在 PID 可读时是精确的。

## 影响

崩溃重启的启动在一个轮询间隔内进入发现阶段，而不是 30 秒。锁文件现在写入换行结尾的 PID 行，`readLockOwner` 防御式解析。手工编辑或损坏的锁内容不会比之前更慢——回退到原有超时行为。

## 测试

`apps/internal/hostlaunch/lock_zombie_test.go` 写入死属主锁并断言 `acquireLock` 以当前 PID 回收。包测试套件（`go test ./...`）覆盖锁竞争与 Host 附着路径。
