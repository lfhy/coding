/** 只接纳能在本地工作簿求值的 Excel 表达式；Host 不执行公式。 */
/** 单条公式的最大 UTF-16 长度，包含起始等号。 */
export const OFFICE_MAX_FORMULA = 8_192

// 用允许名单而非拦截名称：外部链接、可解析任意引用的函数、插件及宏都没有入口。
const FUNCTIONS = new Set(`ABS ACOS ACOSH ADDRESS AGGREGATE AND ASIN ASINH ATAN ATAN2 ATANH AVERAGE AVERAGEA
AVERAGEIF AVERAGEIFS CEILING CEILING.MATH CEILING.PRECISE CHAR CHOOSE CHOOSECOLS CHOOSEROWS CLEAN CODE COLUMN
COLUMNS CONCAT CONCATENATE COS COSH COUNT COUNTA COUNTBLANK COUNTIF COUNTIFS DATE DATEDIF DATEVALUE DAY DAYS
DAYS360 DEGREES DROP EDATE EOMONTH EVEN EXACT EXP EXPAND FILTER FIND FIXED FLOOR FLOOR.MATH FLOOR.PRECISE
FORMULATEXT HLOOKUP HSTACK HYPOT IF IFERROR IFNA IFS INDEX INT ISBLANK ISERR ISERROR ISEVEN ISFORMULA ISLOGICAL
ISNA ISNONTEXT ISNUMBER ISODD ISREF ISTEXT LARGE LEFT LEN LN LOG LOG10 LOOKUP LOWER MATCH MAX MAXA MAXIFS MEDIAN
MID MIN MINA MINIFS MOD MODE MODE.SNGL MONTH MROUND N NA NOT NOW NUMBERVALUE ODD OFFSET OR PERCENTILE
PERCENTILE.EXC PERCENTILE.INC PI POWER PRODUCT PROPER QUARTILE QUARTILE.EXC QUARTILE.INC QUOTIENT RADIANS RAND
RANDARRAY RANDBETWEEN RANK RANK.EQ REPLACE REPT RIGHT ROUND ROUNDDOWN ROUNDUP ROW ROWS SEARCH SECOND SEQUENCE
SIGN SIN SINH SMALL SORT SORTBY SQRT STDEV STDEV.P STDEV.S SUBSTITUTE SUBTOTAL SUM SUMIF SUMIFS SUMPRODUCT SUMSQ
SWITCH T TAKE TAN TANH TEXT TEXTAFTER TEXTBEFORE TEXTJOIN TEXTSPLIT TIME TIMEVALUE TOCOL TODAY TOROW TRANSPOSE
TRIM TRUNC UNICHAR UNICODE UNIQUE UPPER VALUE VAR VAR.P VAR.S VLOOKUP VSTACK WEEKDAY WEEKNUM WORKDAY
WORKDAY.INTL XLOOKUP XMATCH XOR YEAR YEARFRAC`.split(/\s+/u))

const MAX_EXCEL_ROW = 1_048_576
const MAX_EXCEL_COLUMN = 16_384
const SHEET = /'(?:[^'\[\]|:/\\\u0000-\u001f]|'')+'!|[\p{L}\p{N}_.]+!/uy
const STRING = /"(?:[^"]|"")*"/y
const FUNCTION = /[A-Za-z_][A-Za-z_\d.]*(?=\s*\()/y
const ERROR = /#(?:NULL!|DIV\/0!|VALUE!|REF!|NAME\?|NUM!|N\/A|SPILL!|CALC!)/iy
const CELL = /(\$?[A-Z]{1,3})(\$?[1-9]\d{0,6})(?![\p{L}\p{N}_.])/iuy
const COLUMN = /\$?[A-Z]{1,3}(?![\p{L}\p{N}_.])/iuy
const ROW = /\$?[1-9]\d{0,6}(?![\p{L}\p{N}_.])/uy
const NUMBER = /(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?/y
const BOOLEAN = /(?:TRUE|FALSE)(?![\p{L}\p{N}_.])/iuy
const SPACE = /\s*/uy
const OPERATOR = /<>|>=|<=|[+\-*/^&=<>:]/y

interface FormulaRef {
  start: number
  end: number
  column?: string
  row?: string
}

function matchAt(pattern: RegExp, value: string, index: number): RegExpExecArray | undefined {
  pattern.lastIndex = index
  return pattern.exec(value) ?? undefined
}

function invalidFormula(): never {
  throw new TypeError('Excel 公式无效，或含有外部引用、DDE 或不支持的函数')
}

function columnNumber(column: string): number {
  let index = 0
  for (const char of column.replace('$', '').toUpperCase()) index = index * 26 + char.charCodeAt(0) - 64
  return index
}

function columnLetters(number: number): string {
  let result = ''
  while (number > 0) {
    number -= 1
    result = String.fromCharCode(65 + number % 26) + result
    number = Math.floor(number / 26)
  }
  return result
}

function spaceEnd(formula: string, start: number): number {
  return start + (matchAt(SPACE, formula, start)?.[0].length ?? 0)
}

function referenceAt(formula: string, start: number, rangeTail: boolean): FormulaRef | undefined {
  const cell = matchAt(CELL, formula, start)
  if (cell !== undefined && cell[1] !== undefined && cell[2] !== undefined) {
    return { start, end: start + cell[0].length, column: cell[1], row: cell[2] }
  }
  const wholeColumn = matchAt(COLUMN, formula, start)?.[0]
  if (wholeColumn !== undefined && (rangeTail || formula[spaceEnd(formula, start + wholeColumn.length)] === ':')) {
    return { start, end: start + wholeColumn.length, column: wholeColumn }
  }
  const wholeRow = matchAt(ROW, formula, start)?.[0]
  if (wholeRow !== undefined && (rangeTail || formula[spaceEnd(formula, start + wholeRow.length)] === ':')) {
    return { start, end: start + wholeRow.length, row: wholeRow }
  }
  return undefined
}

function scan(formula: string, onRef?: (ref: FormulaRef) => void): void {
  if (formula.length < 2 || formula.length > OFFICE_MAX_FORMULA || !formula.startsWith('=')
    || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\ud800-\udfff\ufffe\uffff]/u.test(formula)) invalidFormula()
  const groups: Array<'call' | 'group' | 'array'> = []
  let index = 1
  let needsOperand = true
  let emptyArgument = false
  let rangeTail = false
  while ((index = spaceEnd(formula, index)) < formula.length) {
    const char = formula[index]
    if (char === ')' || char === '}') {
      const group = groups.pop()
      if (group === undefined || (group === 'array') !== (char === '}')
        || needsOperand && !(group === 'call' && emptyArgument)) invalidFormula()
      needsOperand = false
      index += 1
      continue
    }
    if (char === ',' || char === ';') {
      const group = groups.at(-1)
      if (char === ';' && group !== 'array' || needsOperand && !(group === 'call' && emptyArgument)) invalidFormula()
      needsOperand = true
      emptyArgument = group === 'call'
      rangeTail = false
      index += 1
      continue
    }
    if (!needsOperand) {
      if (char === '%' || char === '#') { index += 1; continue }
      const op = matchAt(OPERATOR, formula, index)?.[0]
      if (op === undefined) invalidFormula()
      index += op.length
      needsOperand = true
      emptyArgument = false
      rangeTail = op === ':'
      continue
    }
    if (char === '+' || char === '-' || char === '@') {
      emptyArgument = false
      index += 1
      continue
    }
    if (char === '(' || char === '{') {
      groups.push(char === '(' ? 'group' : 'array')
      emptyArgument = false
      rangeTail = false
      index += 1
      continue
    }
    const fn = matchAt(FUNCTION, formula, index)?.[0]
    if (fn !== undefined) {
      const name = fn.toUpperCase().replace(/^_XLFN\.(?:_XLWS\.)?/u, '')
      if (!FUNCTIONS.has(name)) invalidFormula()
      groups.push('call')
      emptyArgument = true
      rangeTail = false
      index = spaceEnd(formula, index + fn.length) + 1
      continue
    }
    const sheet = matchAt(SHEET, formula, index)?.[0]
    if (sheet !== undefined) index += sheet.length
    const ref = referenceAt(formula, index, rangeTail)
    if (ref !== undefined) {
      if (ref.column !== undefined && columnNumber(ref.column) > MAX_EXCEL_COLUMN
        || ref.row !== undefined && Number(ref.row.replace('$', '')) > MAX_EXCEL_ROW) invalidFormula()
      onRef?.(ref)
      index = ref.end
    } else {
      const literal = matchAt(ERROR, formula, index)?.[0]
        ?? (sheet === undefined
          ? (matchAt(STRING, formula, index) ?? matchAt(NUMBER, formula, index) ?? matchAt(BOOLEAN, formula, index))?.[0]
          : undefined)
      if (literal === undefined || sheet !== undefined && literal.toUpperCase() !== '#REF!') invalidFormula()
      index += literal.length
    }
    rangeTail = false
    needsOperand = false
  }
  if (groups.length !== 0 || needsOperand) invalidFormula()
}

/** 校验公式，保留原文。@param formula - 含起始等号的表达式。@returns 可离线存储的原始公式。 */
export function validateOfficeFormula(formula: string): string {
  scan(formula)
  return formula
}

/** 将共享公式的相对 A1 引用移至从属单元格；绝对引用和字符串不移动。 */
export function shiftOfficeFormula(formula: string, rowDelta: number, columnDelta: number): string {
  let cursor = 0
  let result = ''
  scan(formula, (ref) => {
    const column = ref.column === undefined ? undefined
      : columnNumber(ref.column) + (ref.column.startsWith('$') ? 0 : columnDelta)
    const row = ref.row === undefined ? undefined
      : Number(ref.row.replace('$', '')) + (ref.row.startsWith('$') ? 0 : rowDelta)
    result += formula.slice(cursor, ref.start)
    cursor = ref.end
    if (column !== undefined && (column < 1 || column > MAX_EXCEL_COLUMN)
      || row !== undefined && (row < 1 || row > MAX_EXCEL_ROW)) {
      result += '#REF!'
      return
    }
    if (column !== undefined) result += `${ref.column?.startsWith('$') ? '$' : ''}${columnLetters(column)}`
    if (row !== undefined) result += `${ref.row?.startsWith('$') ? '$' : ''}${row}`
  })
  return validateOfficeFormula(result + formula.slice(cursor))
}
