/** 表格模板：表头文字、分隔行与空数据行。 */
export interface TableTemplate {
  /** 表头各列的占位文字；至少一列，第一列在插入后被选中。 */
  headers: readonly [string, ...string[]]
  /** 数据行数。 */
  rows: number
}

/** 一次插入的全文、改动区间与插入文本，形状与按行缩进一致，便于共用写回路径。 */
export interface TableInsert {
  /** 插入后的全文。 */
  value: string
  /** 插入点下标。 */
  from: number
  /** 插入点下标；表格是纯插入，不覆盖原有内容。 */
  to: number
  /** 要插入的文本。 */
  block: string
  /** 插入后应选中的第一个表头文字起点。 */
  selectionStart: number
  /** 插入后应选中的第一个表头文字终点。 */
  selectionEnd: number
}

/** 拼出 Markdown 表格模板：表头、分隔行与给定行数的空单元格。 */
function tableBlock(template: TableTemplate): string {
  const head = `| ${template.headers.join(' | ')} |`
  const divider = `| ${template.headers.map(() => '---').join(' | ')} |`
  // 空单元格只留一格空格，避免往笔记里写进无意义的行尾空白。
  const row = `| ${template.headers.map(() => '').join(' | ')} |`
  return [head, divider, ...Array.from({ length: template.rows }, () => row)].join('\n')
}

/**
 * 把表格模板插成独立的一段：光标所在行没有正文时插在这一行的位置，已经有正文时接在这一行下面。
 * 前后按 Markdown 块语法补空行——表格前面紧邻正文时不会被识别成表格，后面紧跟正文时也要空一行分开。
 * 插入后选中第一个表头占位文字，直接输入就能改名。
 * @param value - 当前全文。
 * @param caret - 光标下标。
 * @param template - 表头占位文字与数据行数。
 * @returns 插入后的全文、插入区间与要选中的表头文字范围。
 */
export function insertTable(value: string, caret: number, template: TableTemplate): TableInsert {
  const lineStart = value.lastIndexOf('\n', caret - 1) + 1
  const breakAt = value.indexOf('\n', caret)
  const lineEnd = breakAt === -1 ? value.length : breakAt
  const from = value.slice(lineStart, caret).trim() === '' ? lineStart : lineEnd
  const head = value.slice(0, from)
  const tail = value.slice(from)
  const lead = head === '' || head.endsWith('\n\n') ? '' : head.endsWith('\n') ? '\n' : '\n\n'
  const trail = tail === ''
    ? '\n'
    : tail.startsWith('\n\n') ? '' : tail.startsWith('\n') ? '\n' : '\n\n'
  const block = `${lead}${tableBlock(template)}${trail}`
  const cellStart = from + lead.length + 2
  return {
    value: `${head}${block}${tail}`,
    from,
    to: from,
    block,
    selectionStart: cellStart,
    selectionEnd: cellStart + template.headers[0].length,
  }
}
