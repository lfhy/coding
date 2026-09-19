/** PTY 分配和动态 resize 共用的尺寸边界。 */

export const MIN_TERMINAL_COLS = 2
/** PTY 允许的最小行数。 */
export const MIN_TERMINAL_ROWS = 1
/** PTY 允许的最大列数。 */
export const MAX_TERMINAL_COLS = 1_000
/** PTY 允许的最大行数。 */
export const MAX_TERMINAL_ROWS = 1_000

/**
 * 拒绝无法安全跨越 Node、JSON、Go 与原生 PTY 边界的终端尺寸。
 * @param cols - 候选列数。
 * @param rows - 候选行数。
 * @returns 尺寸有效时不返回值。
 */
export function validateTerminalSize(cols: number, rows: number): void {
  if (!Number.isSafeInteger(cols) || cols < MIN_TERMINAL_COLS || cols > MAX_TERMINAL_COLS
    || !Number.isSafeInteger(rows) || rows < MIN_TERMINAL_ROWS || rows > MAX_TERMINAL_ROWS) {
    throw new RangeError(
      `terminal size requires integer cols within ${MIN_TERMINAL_COLS}..${MAX_TERMINAL_COLS} `
      + `and rows within ${MIN_TERMINAL_ROWS}..${MAX_TERMINAL_ROWS}`,
    )
  }
}
