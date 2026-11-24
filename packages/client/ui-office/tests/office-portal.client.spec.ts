// @vitest-environment jsdom
import { afterEach, expect, it } from 'vitest'
import { HOST_CLASS, markOfficeHost } from '../src/client/office-portal.ts'

afterEach(() => { document.body.className = '' })

it('编辑器存活期间标记宿主，按引用计数摘除类名', () => {
  expect(document.body.classList.contains(HOST_CLASS)).toBe(false)
  const first = markOfficeHost()
  const second = markOfficeHost()
  expect(document.body.classList.contains(HOST_CLASS)).toBe(true)

  first()
  first()
  expect(document.body.classList.contains(HOST_CLASS)).toBe(true)

  second()
  expect(document.body.classList.contains(HOST_CLASS)).toBe(false)
})
