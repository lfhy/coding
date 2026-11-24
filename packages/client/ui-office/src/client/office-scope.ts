/** 给 Univer 预设样式补一份「浮层容器自身」版本：@scope 的规则不匹配作用域根元素。 */

/** 浮层容器都是 body 直属节点；复合到这里的选择器既不受作用域根排除影响，也不等运行时标记。 */
const ROOT = 'body > *'

type Block = { selector: string; body: string; media?: string }

/** 跳过字符串与注释，返回与 `open` 处 `{` 配对的 `}` 下标；找不到时返回文本末尾。 */
function matchBrace(css: string, open: number): number {
  let depth = 0
  for (let i = open; i < css.length; i++) {
    const char = css[i]
    if (char === '"' || char === "'") {
      for (i++; i < css.length && css[i] !== char; i++) if (css[i] === '\\') i++
      continue
    }
    if (char === '/' && css[i + 1] === '*') {
      const end = css.indexOf('*/', i + 2)
      i = end < 0 ? css.length : end + 1
      continue
    }
    if (char === '{') depth++
    else if (char === '}' && --depth === 0) return i
  }
  return css.length
}

/** 找到 `from` 之后第一个不在字符串／注释中的 `{`。 */
function findOpen(css: string, from: number): number {
  for (let i = from; i < css.length; i++) {
    const char = css[i]
    if (char === '"' || char === "'") {
      for (i++; i < css.length && css[i] !== char; i++) if (css[i] === '\\') i++
      continue
    }
    if (char === '/' && css[i + 1] === '*') {
      const end = css.indexOf('*/', i + 2)
      i = end < 0 ? css.length : end + 1
      continue
    }
    if (char === '{') return i
  }
  return -1
}

/** 把样式表切成顶层规则；`@media` 保留条件，其余 at-规则整体忽略。 */
function blocks(css: string): Block[] {
  const found: Block[] = []
  let i = 0
  while (i < css.length) {
    const open = findOpen(css, i)
    if (open < 0) break
    const head = css.slice(i, open).trim()
    const close = matchBrace(css, open)
    const body = css.slice(open + 1, close)
    if (head.startsWith('@')) {
      if (/^@media\b/.test(head)) found.push({ selector: '', body, media: head })
    } else if (head !== '') found.push({ selector: head, body })
    i = close + 1
  }
  return found
}

/** 按顶层逗号切分选择器列表，保留 `:is(a, b)` 之类的括号内容。 */
function splitSelectors(list: string): string[] {
  const out: string[] = []
  let depth = 0
  let current = ''
  for (const char of list) {
    if (char === '(' || char === '[') depth++
    else if (char === ')' || char === ']') depth--
    if (char === ',' && depth === 0) { out.push(current.trim()); current = '' } else current += char
  }
  if (current.trim() !== '') out.push(current.trim())
  return out
}

/**
 * 该选择器能否原样复合到浮层容器上：只有单个复合选择器才有「容器自身」等价物，带后代或
 * 组合符的选择器保持原样交给 @scope；`hover:`／`dark:` 这类变体可保留，条件写在伪类里。
 */
function compoundsToRoot(selector: string): boolean {
  if (selector === '*') return true
  if (!selector.startsWith('[data-u-comp') && !(selector.startsWith('.') && selector.includes('univer-'))) return false
  let depth = 0
  for (const char of selector) {
    if (char === '(' || char === '[') depth++
    else if (char === ')' || char === ']') depth--
    else if (depth === 0 && (char === ' ' || char === '>' || char === '+' || char === '~' || char === '\n')) return false
  }
  return true
}

/** 把一条规则的选择器列表转成只命中浮层容器自身的版本；没有可复合的选择器时返回空串。 */
function selfSelector(list: string): string {
  const kept = splitSelectors(list).filter(compoundsToRoot)
    .map(selector => selector === '*' ? ROOT : `${ROOT}${selector}`)
  return kept.join(',')
}

/** 递归生成容器自身版本；`@media` 条件原样保留。 */
function rewrite(css: string): string {
  const out: string[] = []
  for (const block of blocks(css)) {
    if (block.media !== undefined) {
      const inner = rewrite(block.body)
      if (inner !== '') out.push(`${block.media}{${inner}}`)
      continue
    }
    const selector = selfSelector(block.selector)
    if (selector !== '') out.push(`${selector}{${block.body}}`)
  }
  return out.join('')
}

const cache = new Map<string, string>()

/**
 * 生成让 Univer 浮层容器自身也拿到预设样式的补充规则。
 *
 * 预设样式用 `@scope` 限定在画布和浮层容器内，但 `@scope` 的规则不匹配作用域根元素；
 * 挂在 body 下的悬停说明、块菜单等容器正是作用域根，缺了 `position: absolute` 之类的工具类
 * 后留在文档流里把整页撑高，引出页面滚动条。补充规则只复合单个 Univer 工具类，
 * 因此只会命中这些容器自身的工具类名，不影响页面其它部分。
 * @param css - 已去掉外链资源的预设样式文本。
 * @returns 可直接追加在 @scope 块之后的补充规则。
 */
export function selfScopedRules(css: string): string {
  const cached = cache.get(css)
  if (cached !== undefined) return cached
  const rules = rewrite(css)
  cache.set(css, rules)
  return rules
}
