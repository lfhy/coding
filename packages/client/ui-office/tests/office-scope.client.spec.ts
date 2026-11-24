import { expect, it } from 'vitest'
import { selfScopedRules } from '../src/client/office-scope.ts'

it('单个工具类与 hover 变体复合到 body 直属浮层容器，后代选择器保持原样', () => {
  const css = '.univer-absolute{position:absolute}.univer-x .univer-y{color:red}'
    + '.hover\\:univer-bg-gray-50:hover{color:blue}'
  expect(selfScopedRules(css)).toBe('body > *.univer-absolute{position:absolute}'
    + 'body > *.hover\\:univer-bg-gray-50:hover{color:blue}')
})

it('根元素变量与 @media 内的规则一并补上', () => {
  const css = '*, :before{--tw-x:0}.univer-w-fit{width:fit-content}'
    + '@media (min-width:600px){.univer-fixed{position:fixed}.univer-a>.univer-b{color:red}}'
  expect(selfScopedRules(css)).toBe('body > *{--tw-x:0}body > *.univer-w-fit{width:fit-content}'
    + '@media (min-width:600px){body > *.univer-fixed{position:fixed}}')
})

it('动画与其它 at-规则不重复输出，注释与引号内的花括号不影响切分', () => {
  const css = '@keyframes spin{from{opacity:0}to{opacity:1}}'
    + '.univer-inline-flex{display:inline-flex}'
    + '.univer-quote::after{content:"{"}'
    + '/* .univer-commented{color:red} */'
  expect(selfScopedRules(css)).toBe('body > *.univer-inline-flex{display:inline-flex}'
    + 'body > *.univer-quote::after{content:"{"}')
})
