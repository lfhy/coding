import { describe, expect, it } from 'vitest'
import {
  CENTER_MIN, clampWidth, computeColumns, computeWorkbenchBottom, computeWorkbenchColumns,
  DETAILS_DEFAULT, DETAILS_MIN, SIDEBAR_COLLAPSED, SIDEBAR_DEFAULT, SIDEBAR_MIN,
  WORKBENCH_BOTTOM_DEFAULT, WORKBENCH_BOTTOM_MAX, WORKBENCH_BOTTOM_MIN,
  WORKBENCH_DEFAULT, WORKBENCH_MAX, WORKBENCH_MIN, WORKBENCH_TOP_MIN,
} from '@deepseek-ai/dsh-client-ui-layout/src/client/columns.ts'

// 数字偏好中 0 表示关闭；辅助函数让场景名称保持易读。
const open = (width: number) => width
const closed = (_width: number) => 0

describe('clampWidth', () => {
  it('clamps into the range and rounds', () => {
    expect(clampWidth(250.4, 240, 420)).toBe(250)
    expect(clampWidth(100, 240, 420)).toBe(240)
    expect(clampWidth(9999, 240, 420)).toBe(420)
  })
})

describe('computeColumns', () => {
  it('step 1: everything fits at preferred widths', () => {
    const cols = computeColumns(1920, open(SIDEBAR_DEFAULT), open(DETAILS_DEFAULT))
    expect(cols).toEqual({ sidebar: 280, center: 1920 - 280 - 360, details: 360 })
  })

  it('closed sidebar keeps its compact rail while closed details contribute zero width', () => {
    expect(computeColumns(1920, closed(300), closed(360)))
      .toEqual({ sidebar: SIDEBAR_COLLAPSED, center: 1920 - SIDEBAR_COLLAPSED, details: 0 })
  })

  it('preferences beyond the clamp range are clamped before solving', () => {
    const cols = computeColumns(1920, open(9999), open(1))
    expect(cols.sidebar).toBe(420)
    expect(cols.details).toBe(300)
    expect(computeColumns(1920, open(1), open(DETAILS_DEFAULT)).sidebar).toBe(SIDEBAR_MIN)
  })

  it('step 2: details shrinks first, center pinned at min', () => {
    // 280 + 360 + 640 = 1280 > 1250；详情栏让步到 1250-280-640 = 330。
    const cols = computeColumns(1250, open(SIDEBAR_DEFAULT), open(DETAILS_DEFAULT))
    expect(cols).toEqual({ sidebar: 280, center: CENTER_MIN, details: 330 })
  })

  it('boundary: exactly at the step-1/step-2 seam', () => {
    const cols = computeColumns(300 + 360 + CENTER_MIN, open(300), open(360))
    expect(cols).toEqual({ sidebar: 300, center: CENTER_MIN, details: 360 })
    const one = computeColumns(300 + 360 + CENTER_MIN - 1, open(300), open(360))
    expect(one).toEqual({ sidebar: 300, center: CENTER_MIN, details: 359 })
  })

  it('step 3: details auto-closes when its min still starves center — sidebar holds its preference', () => {
    // 280 + 300 + 640 = 1220 > 1210；详情栏关闭，导航栏不变，对话区为 930。
    const cols = computeColumns(1210, open(SIDEBAR_DEFAULT), open(DETAILS_DEFAULT))
    expect(cols).toEqual({ sidebar: 280, center: 930, details: 0 })
  })

  it('the sidebar never concedes: center absorbs the deficit below CENTER_MIN', () => {
    // 700 < 280+640；导航栏保留 280，对话区承担缺口后为 420。
    const cols = computeColumns(700, open(SIDEBAR_DEFAULT), closed(DETAILS_DEFAULT))
    expect(cols).toEqual({ sidebar: SIDEBAR_DEFAULT, center: 420, details: 0 })
  })

  it('sidebar-closed narrow window: details concedes then auto-closes', () => {
    const fits = computeColumns(SIDEBAR_COLLAPSED + DETAILS_MIN + CENTER_MIN, closed(300), open(DETAILS_DEFAULT))
    expect(fits).toEqual({ sidebar: SIDEBAR_COLLAPSED, center: CENTER_MIN, details: DETAILS_MIN })
    const starved = computeColumns(SIDEBAR_COLLAPSED + DETAILS_MIN + CENTER_MIN - 1, closed(300), open(DETAILS_DEFAULT))
    expect(starved).toEqual({
      sidebar: SIDEBAR_COLLAPSED,
      center: DETAILS_MIN + CENTER_MIN - 1,
      details: 0,
    })
  })

  it('tiny viewport: details closes, sidebar holds, center takes the remainder', () => {
    const cols = computeColumns(400, open(SIDEBAR_DEFAULT), open(DETAILS_DEFAULT))
    expect(cols.details).toBe(0)
    expect(cols.sidebar).toBe(SIDEBAR_DEFAULT)
    expect(cols.center).toBe(Math.max(0, 400 - SIDEBAR_DEFAULT))
  })

  it('recovery is pure: re-widening restores preferred widths untouched', () => {
    const squeezed = computeColumns(1100, open(SIDEBAR_DEFAULT), open(DETAILS_DEFAULT))
    expect(squeezed.details).toBe(0)
    const restored = computeColumns(1920, open(SIDEBAR_DEFAULT), open(DETAILS_DEFAULT))
    expect(restored.details).toBe(DETAILS_DEFAULT)
    expect(restored.sidebar).toBe(SIDEBAR_DEFAULT)
  })
})

describe('computeColumns — degenerate viewports', () => {
  it('sidebar closed and viewport below CENTER_MIN: details auto-closes, center takes the rest', () => {
    // 紧凑 rail 下同样进入详情栏自动关闭分支。
    expect(computeColumns(500, closed(300), open(DETAILS_DEFAULT)))
      .toEqual({ sidebar: SIDEBAR_COLLAPSED, center: 500 - SIDEBAR_COLLAPSED, details: 0 })
  })
})

describe('computeWorkbenchColumns', () => {
  it('keeps the default workbench usable beside conversation at 1110px', () => {
    expect(computeWorkbenchColumns(1110, SIDEBAR_DEFAULT, WORKBENCH_DEFAULT, false)).toEqual({
      sidebar: 280,
      conversation: 400,
      workbench: 430,
    })
  })

  it('clamps preferences and protects the conversation while room remains', () => {
    expect(computeWorkbenchColumns(1920, 0, 1, false)).toEqual({
      sidebar: SIDEBAR_COLLAPSED,
      conversation: 1920 - SIDEBAR_COLLAPSED - WORKBENCH_MIN,
      workbench: WORKBENCH_MIN,
    })
    expect(computeWorkbenchColumns(4000, SIDEBAR_DEFAULT, 9999, false).workbench).toBe(WORKBENCH_MAX)
    expect(computeWorkbenchColumns(1000, SIDEBAR_DEFAULT, WORKBENCH_DEFAULT, false)).toEqual({
      sidebar: SIDEBAR_DEFAULT,
      conversation: 400,
      workbench: 320,
    })
  })

  it('holds the workbench minimum before letting conversation absorb a deficit', () => {
    expect(computeWorkbenchColumns(900, SIDEBAR_DEFAULT, WORKBENCH_DEFAULT, false)).toEqual({
      sidebar: SIDEBAR_DEFAULT,
      conversation: 320,
      workbench: WORKBENCH_MIN,
    })
    expect(computeWorkbenchColumns(200, SIDEBAR_DEFAULT, WORKBENCH_DEFAULT, false)).toEqual({
      sidebar: SIDEBAR_DEFAULT,
      conversation: 0,
      workbench: 0,
    })
  })

  it('fullscreen gives every non-sidebar pixel to the workbench', () => {
    expect(computeWorkbenchColumns(980, 0, WORKBENCH_DEFAULT, true)).toEqual({
      sidebar: SIDEBAR_COLLAPSED,
      conversation: 0,
      workbench: 980 - SIDEBAR_COLLAPSED,
    })
  })
})

describe('computeWorkbenchBottom', () => {
  it('returns zero while hidden and the preferred height while it fits', () => {
    expect(computeWorkbenchBottom(1080, WORKBENCH_BOTTOM_DEFAULT, false)).toBe(0)
    expect(computeWorkbenchBottom(1080, WORKBENCH_BOTTOM_DEFAULT, true)).toBe(WORKBENCH_BOTTOM_DEFAULT)
  })

  it('clamps preferences and yields to a short upper workspace', () => {
    expect(computeWorkbenchBottom(1080, 1, true)).toBe(WORKBENCH_BOTTOM_MIN)
    expect(computeWorkbenchBottom(1080, 9999, true)).toBe(WORKBENCH_BOTTOM_MAX)
    expect(computeWorkbenchBottom(300, WORKBENCH_BOTTOM_DEFAULT, true)).toBe(300 - WORKBENCH_TOP_MIN)
    expect(computeWorkbenchBottom(100, WORKBENCH_BOTTOM_DEFAULT, true)).toBe(0)
  })
})
