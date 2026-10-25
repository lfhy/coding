---
name: javascript-electron-analysis
description: 分析 Electron 应用、ASAR 包、打包后的 JavaScript 前端与网站 bundle：解包、模块与导入图、Electron 边界与 fuse、运行时 Inspector、网络抓包。目标含 app.asar、resources/app、bundle.js 或已打开的 Electron／浏览器应用时加载。
---

# JavaScript 与 Electron 分析

这一类的目标是可读的 JavaScript——只是被包起来、被压缩或被混淆。优先用包结构和静态分析回答，不轻易启动目标。

## 静态分析优先

解包后的目录、ASAR 或 `resources/app` 用 `analyze_javascript_application` 直接分析，不需要原生引擎，也不需要打开应用。大工程先要 `detail: "summary"`，再用 `parent_evidence_id` 分页查看模块、导入图与 Electron 边界。

需要关注的结构：进程边界（main、preload、renderer、utility）、IPC 通道名与它们的处理函数、加载的远端地址、更新器与协议处理、原生模块（`.node`）、打包进去的证书与密钥、内置的本地服务与端口。压缩后的变量名本身不是信息，字符串字面量、属性名和导出边界才是。

多个模块可以共用一个模块身份，图中的 `node_id` 才是选择项，路径只是标签——先按模块取身份再取内容。

## Electron 的额外事实

- preload 暴露了什么给渲染进程，是权限面的关键：`contextBridge.exposeInMainWorld` 暴露的对象就是页面能触达的原生能力。
- 打包后的 fuse 决定能不能用 Inspector：尝试以 `--inspect` 附加之前先用 `inspect_electron_fuses` 检查 `EnableNodeCliInspectArguments`；该 fuse 关闭时应用会忽略该参数，不要把它当成「附加失败」反复重试。
- 已运行的 Electron 目标用 `list_electron_targets` 发现；静态结论说明「代码会做」，运行观测说明「这次做了」。

## 网络与协议

前端与服务的交互通常只能在运行时看清。用户已提供 HAR、Fiddler `.saz`、mitmproxy 或 aioquic qlog 记录时，用 `inspect_web_network_capture` 读取：默认只看摘要，再按原始记录序号或分页查看字段。记录里的 URL 是历史事实，读取不会访问它，也不构成对流量的当前归属判断。

需要自己抓流量时，走浏览器工具或用户自己的代理配置；不要发起未授权的中间人拦截，也不要对第三方服务重放请求。

## 与浏览器的分工

要观察渲染后的界面、执行页面内交互或验证自己的改动，用本产品的 `browser_*` 工具（另见 `browser-use` 技能），它们在同一窗口里可被用户看到。REA 的浏览器捕获（`capture_browser_scenario`）用于产出可复用的场景记录与 AgentEnv 包，适合需要留证或交付的场合。

## 混淆与打包

字符串数组轮转、控制流平坦化、十六进制字符串在运行时拼装、`eval`/`Function` 构造都算混淆。处理顺序：先跑一次静态分析得到模块与字符串清单，再定位解混淆点（通常在入口附近），必要时到运行时取已经解出的字符串。每一步都要说明改动了什么，不要整体手工还原一个打包器。

## 输出

应用形态与版本 → 进程与模块地图 → 与问题相关的调用路径（模块、函数、行或证据 ID）→ IPC 与网络行为 → 需要的运行时确认点 → 未知项。
