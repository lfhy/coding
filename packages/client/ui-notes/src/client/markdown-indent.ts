/** Markdown 列表按两格一层缩进，与源码视图的 tab-size 一致。 */
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
