---
name: website-inspection
description: 采集会改变实现的证据：区块结构、字体与几何、真实资产、以及触发到状态的行为。复刻前的观测与复刻后的对比都按这里的方法做。
---

# 检查一个源页面

采集**会改变实现**的证据：布局、内容、资产与状态。通常每页一份页面简报就够。

## 视觉结构

记录区块顺序、最大宽度、外边距、栏宽比例与粘性／固定图层。量出标题与正文字体族、字重、字号、行高与字间距。先对齐真实字体，再靠调宽度去修换行。

让宽度从移动端一路扫到比桌面设计更宽，在每个过渡点附近加密采样；`max-width` 只在更宽的屏幕上才看得出来。记录堆叠关系、导航／菜单变化、文字重排与不同的裁切／资产。把桌面截图缩小不是移动端参考。

访问过懒加载／入场区块之后再补整页证据，另外单独留整幅首屏与交互视图。字体未加载或入场动画未结束时的截图会误导。

## 资产

用浏览器的资产清单与下载能力，或 DOM 上真实存在的 URL 直接下载。需要覆盖：

- 图片：`currentSrc`、`srcset`、尺寸、`object-fit`、裁切位置、alt 文本。
- 图层：可见的图片、背景与 SVG，以及它们的堆叠与定位。
- 视频：源地址、封面、自动播放／循环／静音行为、宽高比、控件。
- 字体：页面实际加载的字体族与字重，以及它用的字体文件。
- SVG：`viewBox` 以及它引用的渐变、遮罩、符号与滤镜。

保存复刻范围内用到的资产，并维护源 URL → 本地路径的映射。重复出现的同名文件要区分。核对内容类型、尺寸与浏览器渲染结果：HTTP 成功也可能返回错误页，CDN 换格式时不会改扩展名。

公共字体或图片经打包流程取不到时，直接下载观测到的 URL。无法解决的资产明确列出来，并保留适用的归属说明。

## 状态证据

记录「触发 → 可见结果」。先滚动到位再点击，免得把粘性场景当成标签页。检查替代内容、选中态、布局与过渡。

用浏览器支持的 DOM 求值量出重要的前后样式。对页面上观测到的选择器，有用的字段是 `textContent`、`getBoundingClientRect()`，以及计算后的 font、letterSpacing、color、background、gap、padding、borderRadius、position、transform 与 transition。

整页脚本（平滑滚动、滚动吸附、跟随光标的元素、页面转场）会改变每一次交互。从根元素 class、全局样式与已加载脚本里找出它们并记录选项。

求值环境之间的能力不同：只读的 DOM 快照可能没有 `document.fonts` 一类 API。缺少的量测改用资产元数据或开发者工具取得，不要从不可用的 API 反推数值。

## 交接与比较

交付内容包括截图、几何与字体、内容、本地资产路径、响应式变化与触发／状态行为。并行做多个页面前，先把共享导航与样式定下来。

对比截图按 URL／路由与视口命名。测试控件并检查它们的可见结果。移动端溢出与资产加载失败要和相似度分开检查。

## 本产品的可用工具

- `browser_navigate`、`browser_page_info`、`browser_snapshot`、`browser_scroll`、`browser_click`、`browser_fill`、`browser_hover`、`browser_key`、`browser_read_element`、`browser_select`、`browser_check`、`browser_drag`、`browser_wait_for_selector`、`browser_wait_for_response` 负责看页面与操作状态。
- 一次调用里要同时设视口、读计算样式并截图时用 `browser_script`：`cdp('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 3, mobile: true })`，随后 `page.evaluate(...)` 取量测、`page.screenshot({ path })` 存档。设备覆写在本次调用结束时失效，所以别把设视口和截图拆成两次调用。
- 视觉判断必须 `browser_screenshot` 并真的看图；语义快照只说明结构。
- 资产下载用 `browser_http` 或 Shell 里的 `curl`，落盘后核对文件类型与像素尺寸。

需要登录才可见的状态，按提示词里的登录续期规则请用户在右侧 Agent 浏览器面板完成，确认后再继续采集。
