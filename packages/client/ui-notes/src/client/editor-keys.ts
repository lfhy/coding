/** 源码视图的编辑器按键语义：Tab／Shift+Tab 缩进，Home／End 落在逻辑行首尾。 */

/** 一级缩进：两格空格，与源码视图的 tab-size 一致。 */
const INDENT_UNIT = '  '

/** 一次按行缩进的结果：新的全文、被替换的区间和编辑后应保持的选区。 */
export interface IndentEdit {
  /** 缩进后的全文。 */
  value: string
  /** 改动区间起点，位于第一行行首。 */
  from: number
  /** 改动区间终点，位于最后一行的行尾。 */
  to: number
  /** 用来替换 [from, to) 的文本。 */
  block: string
  /** 编辑后应恢复的选区起点。 */
  selectionStart: number
  /** 编辑后应恢复的选区终点。 */
  selectionEnd: number
}

/** 一次按键后的全文与选区；只移动光标时全文不变。 */
export interface CaretEdit {
  /** 按键后的全文。 */
  value: string
  /** 按键后的选区起点。 */
  selectionStart: number
  /** 按键后的选区终点。 */
  selectionEnd: number
  /** 按键后的选区方向。 */
  selectionDirection: 'forward' | 'backward' | 'none'
}

/** 逻辑行在全文中的边界。 */
export interface LineEdges {
  /** 行首下标。 */
  start: number
  /** 行尾下标，不含换行符。 */
  end: number
}

/**
 * 取下标所在逻辑行的边界。Markdown 源码按换行符分行，软换行不算新行，
 * Home／End 因此落在逻辑行的首尾。
 * @param value - 全文。
 * @param index - 光标下标。
 * @returns 该行起止下标；行尾不含 `\n` 与 `\r\n` 的换行符。
 */
export function lineEdges(value: string, index: number): LineEdges {
  const clamped = Math.min(Math.max(index, 0), value.length)
  const start = value.lastIndexOf('\n', clamped - 1) + 1
  const breakAt = value.indexOf('\n', clamped)
  const rawEnd = breakAt === -1 ? value.length : breakAt
  return { start, end: rawEnd > start && value[rawEnd - 1] === '\r' ? rawEnd - 1 : rawEnd }
}

/**
 * 在光标处插入一级缩进：对应编辑器里 Tab 的缩进语义，焦点留在输入框里，
 * 不会跳到下一个控件。
 * @param value - 全文。
 * @param caret - 光标下标。
 * @returns 插入缩进后可替换的区间、替换文本和新的光标位置。
 */
export function indentAtCaret(value: string, caret: number): IndentEdit {
  return {
    value: value.slice(0, caret) + INDENT_UNIT + value.slice(caret),
    from: caret,
    to: caret,
    block: INDENT_UNIT,
    selectionStart: caret + INDENT_UNIT.length,
    selectionEnd: caret + INDENT_UNIT.length,
  }
}

/**
 * 计算 Home／End 的落点：把选区里会移动的那一端挪到逻辑行首或行尾。
 * Home 先落在行内首个非空白字符，已经在那里时再回到行首，与代码编辑器一致；
 * 按住 Shift 时保留另一端作锚点，等价于只把光标移到行首／行尾并选中中间内容。
 * @param value - 全文。
 * @param start - 选区起点。
 * @param end - 选区终点。
 * @param direction - 选区方向，决定哪一端跟随按键移动。
 * @param edge - `start` 对应 Home，`end` 对应 End。
 * @param extend - 为 true 时保留锚点并扩展选区。
 * @returns 全文不变，只给出新的选区与方向。
 */
export function edgeSelection(
  value: string, start: number, end: number, direction: CaretEdit['selectionDirection'],
  edge: 'start' | 'end', extend: boolean,
): CaretEdit {
  const backward = direction === 'backward'
  const caret = backward ? start : end
  const anchor = backward ? end : start
  const { start: lineStart, end: lineEnd } = lineEdges(value, caret)
  const target = edge === 'start' ? homeTarget(value, caret, lineStart) : lineEnd
  if (!extend) return { value, selectionStart: target, selectionEnd: target, selectionDirection: 'none' }
  return {
    value,
    selectionStart: Math.min(anchor, target),
    selectionEnd: Math.max(anchor, target),
    selectionDirection: target < anchor ? 'backward' : 'forward',
  }
}

/**
 * Home 的落点：行内首个非空白字符；光标已经在那里时回到行首。
 * @param value - 全文。
 * @param caret - 光标下标。
 * @param lineStart - 该行行首下标。
 * @returns Home 应落到的下标。
 */
function homeTarget(value: string, caret: number, lineStart: number): number {
  let firstText = lineStart
  while (firstText < value.length && (value[firstText] === ' ' || value[firstText] === '\t')) firstText += 1
  return caret === firstText ? lineStart : firstText
}

/** 去掉一行开头的一级缩进：优先删一个制表符，否则最多删两格空格。 */
function outdentLine(line: string): string {
  if (line.startsWith('\t')) return line.slice(1)
  return line.slice(/^ {1,2}/u.exec(line)?.[0].length ?? 0)
}

/**
 * 缩进一行；空行保持原样，否则会在 Markdown 里留下行尾的两格空格（即硬换行标记）。
 * @param line - 单行文本，不含换行符。
 * @returns 缩进后的该行。
 */
function indentLine(line: string): string {
  return line === '' ? line : INDENT_UNIT + line
}

/**
 * 计算把选区覆盖的整行缩进一级或退一级后的全文与选区，供源码视图的 Tab／Shift+Tab 使用。
 *
 * 选区停在行首时这一行不算选中，与代码编辑器逐行缩进的习惯一致；退一级只吃掉行首已有的空白，
 * 没有可删空白的行保持原样。没有可改动的行时原样返回，调用方据此交回默认行为。
 * @param value - 当前全文。
 * @param start - 选区起点。
 * @param end - 选区终点。
 * @param outdent - 为 true 时退一级缩进，否则缩进一级。
 * @returns 新的全文、改动区间、替换文本和覆盖这些整行的选区。
 */
export function indentSelection(value: string, start: number, end: number, outdent: boolean): IndentEdit {
  const from = value.lastIndexOf('\n', start - 1) + 1
  const tail = end > start && value[end - 1] === '\n' ? end - 1 : end
  const breakAt = value.indexOf('\n', tail)
  const to = breakAt === -1 ? value.length : breakAt
  const block = value.slice(from, to)
  const lines = block.split('\n')
  const next = (outdent ? lines.map(outdentLine) : lines.map(indentLine)).join('\n')
  // 一行空白都没有时退不动，保留调用方原来的选区。
  if (next === block) return { value, from, to, block, selectionStart: start, selectionEnd: end }
  return {
    value: value.slice(0, from) + next + value.slice(to),
    from,
    to,
    block: next,
    selectionStart: from,
    selectionEnd: from + next.length,
  }
}
