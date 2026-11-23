/** 真实组合验证窗口外壳、内层尺寸、侧栏折叠、主题和原生安全区。 */
import type { Browser, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import { launchWebScaffold, watchConsole, type WebScaffold } from './scaffold.ts'
import { newEnglishPage, saveFailureShot } from './support.ts'

describe('Web 窗口外壳', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>

  beforeAll(async () => {
    scaffold = await launchWebScaffold({})
    const executablePath = process.env.DSH_PLAYWRIGHT_EXECUTABLE_PATH
    browser = await chromium.launch(executablePath === undefined ? {} : { executablePath })
    page = await newEnglishPage(browser)
    tripwire = watchConsole(page)
    await page.goto(scaffold.baseUrl, { waitUntil: 'load' })
    await page.locator('[data-window-content] #dsh-layout-sidebar').waitFor({ timeout: 30_000 })
    await page.getByTestId('hero-greeting').waitFor({ timeout: 15_000 })
  }, 120_000)

  afterAll(async () => {
    await browser?.close()
    await scaffold?.close()
  })

  it('将原侧栏和会话放在内嵌表面，折叠、设置和返回后保留同一布局', async () => {
    onTestFailed(() => saveFailureShot(page, 'window-shell-navigation'))
    const shell = page.locator('[data-window-shell]')
    const surface = page.locator('[data-window-content]')
    const sidebar = page.locator('#dsh-layout-sidebar')
    const frame = sidebar.locator('..')
    // 外壳没有自己的顶栏：内层表面贴住窗口上沿，导航列顶部只留窗口拖拽垫片。
    expect(await shell.locator('header').count()).toBe(0)
    expect(await shell.locator(':scope > [data-window-drag-region]').count()).toBe(1)
    expect(await surface.locator('#dsh-layout-floating-conversation').count()).toBe(1)
    // 左列 52px 导航卡与内层表面之间留 8px 窗口底色，两侧各 8px 内边距。
    expect(await surface.boundingBox()).toMatchObject({ x: 68, y: 0, width: 1604, height: 992 })
    const logo = page.getByTestId('hero-brand-mark').locator('img')
    expect(await logo.evaluate(async (image: HTMLImageElement) => {
      await image.decode()
      return image.naturalWidth > 0 && image.getBoundingClientRect().width === 34
    })).toBe(true)
    const logoResponse = await page.request.get(new URL('/favicon.png', scaffold.baseUrl).href)
    expect(logoResponse.headers()['content-type']).toBe('image/png')
    const navigation = page.getByRole('navigation', { name: 'Main navigation', exact: true })
    const home = navigation.getByRole('button', { name: 'Back to conversation' })
    expect(await home.locator('img').count()).toBe(0)
    expect(await home.locator('svg').count()).toBe(1)
    const settings = navigation.getByRole('button', { name: 'Settings', exact: true })
    expect(await settings.boundingBox()).toMatchObject({ x: 16, y: 951, width: 36, height: 36 })
    expect(await sidebar.getByRole('button', { name: 'Settings', exact: true }).count()).toBe(0)
    // 侧栏开关固定在外层导航底部，排在主题切换与设置之前；页内不再渲染第二枚。
    const toggle = navigation.getByRole('button', { name: 'Collapse sidebar', exact: true })
    expect(await toggle.boundingBox()).toMatchObject({ x: 16, y: 863, width: 36, height: 36 })
    expect(await sidebar.getByRole('button', { name: 'Collapse sidebar', exact: true }).count()).toBe(0)
    // 键盘聚焦即显示提示，Enter 收起侧栏；鼠标点过的入口不再因聚焦重现提示，
    // 所以键盘路径先于点击验证。
    await toggle.focus()
    await expect.poll(() => page.getByRole('tooltip', { name: 'Collapse sidebar', exact: true }).count()).toBe(1)
    await toggle.press('Enter')
    await expect.poll(() => frame.getAttribute('data-sidebar-collapsed')).toBe('true')
    await expect.poll(async () => (await sidebar.boundingBox())?.width).toBe(56)
    expect(await settings.isVisible()).toBe(true)
    await navigation.getByRole('button', { name: 'Expand sidebar', exact: true }).click()
    await expect.poll(() => frame.getAttribute('data-sidebar-collapsed')).toBeNull()
    await expect.poll(async () => (await sidebar.boundingBox())?.width).toBe(280)

    await toggle.click()
    await expect.poll(() => frame.getAttribute('data-sidebar-collapsed')).toBe('true')
    await navigation.getByRole('button', { name: 'Expand sidebar', exact: true }).click()

    await settings.click()
    await page.getByRole('main', { name: 'Settings', exact: true }).waitFor()
    await page.keyboard.press('Escape')
    await expect.poll(() => page.getByRole('main', { name: 'Settings', exact: true }).count()).toBe(0)
    await navigation.getByRole('button', { name: 'Back to conversation' }).click()
    expect(await shell.count()).toBe(1)
    expect(await frame.count()).toBe(1)
    expect(scaffold.ctx.sessions.list()).toEqual([])
    expect(tripwire.pageErrors).toEqual([])
  })

  it('按内层可用宽度响应，所有屏幕尺寸都只让内容区域滚动', async () => {
    onTestFailed(() => saveFailureShot(page, 'window-shell-responsive'))
    // 自动折叠按内层布局宽度 1024 判定；窗口外壳两侧共占 76px，所以窗口宽度
    // 减 76 才是内层宽度。
    for (const width of [375, 768, 1024, 1099, 1100, 1440]) {
      await page.setViewportSize({ width, height: 900 })
      const expectedNarrow = width < 1100
      await expect.poll(() => page.locator('#dsh-layout-sidebar').locator('..')
        .getAttribute('data-sidebar-collapsed')).toBe(expectedNarrow ? 'true' : null)
      const dimensions = await page.evaluate(() => {
        const surface = document.querySelector<HTMLElement>('[data-window-content]')!
        const sidebar = document.querySelector<HTMLElement>('#dsh-layout-sidebar')!
        return {
          documentWidth: document.documentElement.scrollWidth,
          documentHeight: document.documentElement.scrollHeight,
          viewportWidth: innerWidth,
          viewportHeight: innerHeight,
          surfaceWidth: surface.clientWidth,
          frameWidth: sidebar.parentElement!.clientWidth,
          // 普通 Web 没有原生窗口按钮：导航列顶部的拖拽垫片不占空间。
          dragInsetHeight: document
            .querySelector<HTMLElement>('[data-window-shell] > [data-window-drag-region]')!
            .getBoundingClientRect().height,
        }
      })
      expect(dimensions.documentWidth).toBe(dimensions.viewportWidth)
      expect(dimensions.documentHeight).toBe(dimensions.viewportHeight)
      expect(dimensions.frameWidth).toBe(dimensions.surfaceWidth)
      expect(dimensions.dragInsetHeight).toBe(0)
    }
  })

  it('跟随系统明暗，并把原生窗口安全区交给内层各自避让', async () => {
    await page.emulateMedia({ colorScheme: 'light' })
    await expect.poll(() => page.locator('body').getAttribute('data-ds-dark-theme')).toBeNull()
    const light = await page.locator('[data-window-shell]').evaluate(element => getComputedStyle(element).backgroundColor)
    await page.emulateMedia({ colorScheme: 'dark' })
    await expect.poll(() => page.locator('body').getAttribute('data-ds-dark-theme')).not.toBeNull()
    const dark = await page.locator('[data-window-shell]').evaluate(element => getComputedStyle(element).backgroundColor)
    expect(dark).not.toBe(light)
    for (const [top, right] of [[38, 0], [0, 138], [0, 0]] as const) {
      const style = await page.addStyleTag({
        content: `:root { --app-safe-area-inset-top: ${top}px; --app-safe-area-inset-right: ${right}px; }`,
      })
      const safeArea = await page.evaluate(() => {
        const surface = document.querySelector<HTMLElement>('[data-window-content]')!
        const inset = document.querySelector<HTMLElement>('[data-window-shell] > [data-window-drag-region]')!
        const sidebar = document.querySelector<HTMLElement>('#dsh-layout-sidebar')!
        const sidebarStyle = getComputedStyle(sidebar)
        return {
          contentTop: surface.getBoundingClientRect().top,
          dragInsetHeight: inset.getBoundingClientRect().height,
          sidebarSafeTop: sidebarStyle.getPropertyValue('--app-safe-area-inset-top').trim(),
          sidebarSafeRight: sidebarStyle.getPropertyValue('--app-safe-area-inset-right').trim(),
        }
      })
      expect(safeArea).toEqual({
        contentTop: 0,
        dragInsetHeight: top,
        sidebarSafeTop: `${top}px`,
        sidebarSafeRight: `${right}px`,
      })
      await style.evaluate((element: HTMLStyleElement) => { element.remove() })
    }
    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
  })
})
