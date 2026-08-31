package remoteagent

import (
	"errors"
	"sync/atomic"
	"time"
)

// errCodeComputeBudgetExhausted 表示一次进入 Goja 的执行片段耗尽了累计忙碌
// 时间。它不是模型可见错误；调用方把它映射为稳定的 timeout 终态。
var errCodeComputeBudgetExhausted = errors.New("remote code runner: compute budget exhausted")

// codeActiveBudget 只由执行 Goja 的 goroutine 顺序调用 run。每段 Goja 执行
// 开始一个独立计时器，等待本地 Host binding 回包的 select 不会进入该计时器。
// active 使用 epoch 避免旧计时器在下一段执行期间中断 runtime。
type codeActiveBudget struct {
	remaining time.Duration
	next      atomic.Uint64
	active    atomic.Uint64
	expired   atomic.Bool
	onExpired func()
}

func newCodeActiveBudget(compute time.Duration, onExpired func()) *codeActiveBudget {
	return &codeActiveBudget{remaining: compute, onExpired: onExpired}
}

// run 计入 operation 实际占用 Goja 的时间。若运行期计时器先触发，它以当前
// epoch 中断 runtime；若调度延迟让 operation 返回后才观察到越界，仍按 timeout
// 结算，绝不把超出累计预算的完成值发布出去。
func (budget *codeActiveBudget) run(operation func() error) error {
	if budget.expired.Load() || budget.remaining <= 0 {
		return errCodeComputeBudgetExhausted
	}
	epoch := budget.next.Add(1)
	started := time.Now()
	budget.active.Store(epoch)
	timer := time.AfterFunc(budget.remaining, func() {
		if !budget.active.CompareAndSwap(epoch, 0) {
			return
		}
		budget.expired.Store(true)
		budget.onExpired()
	})
	err := operation()
	elapsed := time.Since(started)
	if !budget.active.CompareAndSwap(epoch, 0) {
		_ = timer.Stop()
		return errCodeComputeBudgetExhausted
	}
	_ = timer.Stop()
	if elapsed >= budget.remaining {
		budget.remaining = 0
		budget.expired.Store(true)
		return errCodeComputeBudgetExhausted
	}
	budget.remaining -= elapsed
	return err
}
