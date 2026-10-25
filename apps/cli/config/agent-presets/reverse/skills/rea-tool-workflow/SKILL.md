---
name: rea-tool-workflow
description: 选择 REA 分析工具、读取保留证据、以及工具缺失或超时时的恢复路径。加载反向工程技能包前或遇到 mcp__rea__ 调用失败、超时、结果被截断时加载本技能。
---

# REA 工具的工作方式

REA（Reverse Engineer Anything）以 MCP 服务器的形式接入本模式，工具注册为 `mcp__rea__<原始名称>`。下文用短名指代，例如 `open_binary` 指 `mcp__rea__open_binary`。

**以本次会话实际注册的工具列表为准。** 本技能按 REA 6.7.0 的工具面编写；较新的服务器会多出工具，较旧的会少。调用不存在的工具名会失败，`binary_session {}` 返回的 `result.tool_availability` 会说明哪些工具不可用以及为什么。

## 先按目标类型选第一个工具

| 目标 | 第一步 |
|---|---|
| 原生可执行文件、库、分析数据库 | `open_binary`，随后直接用聚焦工具；需要清单时 `binary_overview` |
| ZIP/APK/IPA/MSIX/DMG/PyInstaller 这类包或归档 | `open_binary` 建立活动目标；要摘要和发现时 `inspect_artifact`（大清单先 `detail: "summary"`） |
| 解包后的 JavaScript／Electron 树、ASAR、web bundle | `analyze_javascript_application` |
| Apple 应用的 plist、Interface Builder、asset catalog、keyed archive | `inspect_plist`、`decode_interface_builder`、`inspect_asset_catalog`、`inspect_keyed_archive`；它们不解原生代码 |
| Mach-O 切片、加载命令、导入导出、代码签名 | `inspect_macho`、`inspect_signature` |
| Android APK 的清单、类、方法、引用 | `inspect_android_package`，再按需用 `inspect_android_class`、`inspect_android_method`、`search_android_classes`、`trace_android_references`、`decode_android_resources` |
| 托管 PE/CLI 程序集 | `inspect_managed_artifact`，需要成员时 `inspect_managed_members` |
| Flutter／Dart 应用 | `inspect_dart_aot` |
| 固件镜像 | `inspect_firmware_regions`；要真正解包时 `extract_firmware`，输出目录必须由用户指定且是新的绝对路径 |
| 运行时行为、实时调用、仪器化 | 按问题选择运行时工作流（如 `observe_native_calls`、`trace_native_values`、`instrument_with_frida`）；静态工具不观察执行 |
| 已经打开的浏览器页面 | `list_browser_targets`；需要 Agent 自己操作页面时 `capture_browser_scenario` |
| 已经打开的 Electron 运行时 | `list_electron_targets`；尝试 Inspector 前先用 `inspect_electron_fuses` 检查 fuse |
| 真实的 Android 设备或模拟器 | `list_adb_devices`、`inspect_adb_device`，再按需用其它 `*_adb_*` 工具 |
| HAR/SAZ/mitmproxy/qlog 记录 | `inspect_web_network_capture` |
| 抓包记录与字段发现 | `inspect_packet_fields` 选字段，`inspect_packet_capture`／`inspect_pcap_capture` 读取记录 |
| 未知二进制里找 Go／Rust 内嵌元数据、PE 资源、ELF 布局、WASM、EVM 字节码 | 对应的目标无关 `inspect_*`，不需要反汇编引擎 |

目标无关的检查工具直接接收文件路径，不需要 `open_binary`：`inspect_go_binary`、`inspect_rust_binary`、`inspect_pe_resources`、`inspect_binary_layout`、`inspect_wasm_artifact`、`inspect_evm_interface`、`inspect_sqlite_database`、`inspect_recorded_crash`、`inspect_managed_artifact`、`inspect_dart_aot`。

PE 的导入表、证书、加载配置与 Linux 内核模块的 `.modinfo` 没有独立工具：需要反汇编引擎通过 `open_binary` 打开后用 `list_names`／`list_segments`／`read_bytes` 查，或直接用系统工具（`readelf`、`objdump`）配合 `inspect_binary_layout`。

## 摘要是默认，分页是常态

大目标的完整结果会超过模型的上下文，也会超过 MCP 的帧预算。默认流程是：先要 `detail: "summary"`，用返回的 `parent_evidence_id` 再去 `inspect_analysis_view` 取某一节、某一模块或某一页。`analyze_function` 在 MCP 上本来就是摘要优先，完整档案留在 `parent_evidence_id` 后面。

需要跨调用比较时把证据引用传给 `compare_functions`；它要求两边的 `analyze_function` 证据，缺的部分会写成 unknown 而不是猜。`trace_application_feature` 与 `build_call_path` 要求内联完整档案，其余场合请求完整内容会浪费上下文。

结果被客户端截断时，那只是预览，不是权威 JSON：用证据 ID 取小一点的视图，或 `export_evidence_bundle` 把整份证据写到用户项目里。不要为了同样的结果重复分析一次。

## 引擎与 provider 前提

REA 自身不安装分析引擎，它使用主机上已有的东西：

- 原生分析需要 Hopper、Ghidra（含 headless）或 IDA；`open_binary` 的 `provider_id` 选择 provider，IDA 用 `provider_id: "ida"` 且传原始二进制而不是 `.idb`／`.i64`。
- Android 分析需要自备 JADX 与 Java，或在 `tool_availability` 里改用 APK 内省路径；固件拆解在 Linux 上需要 Binwalk 或 Unblob；抓包需要 Tshark；信号记录需要 sigrok-cli；WASM 需要 WABT。
- 纯静态 JavaScript／Electron 分析不需要任何原生引擎，这也是引擎缺失时最有用的降级路径。
- Ghidra 冷启动默认 330 秒。要让新的启动尝试等更久，只能改 REA 进程启动时的环境变量（`REA_GHIDRA_STARTUP_TIMEOUT_MS` 一类），改完需要重启 REA；当前会话里重复同一次冷启动通常只是再等 330 秒。

## 恢复阶梯

按顺序判断，不要跳步：

1. **工具不在列表里**：`binary_session {}` 看 `tool_availability` 与 `analysis_provider_binding`，确认是「当前没有活动目标」「provider 不支持该操作」还是「客户端没有连上」。
2. **调用被拒绝**：先读错误文本。REA 返回的错误说明目标、参数或 provider 的问题；客户端侧的拒绝通常是会话权限或工具不可用，此时请用户调整权限或重开会话，而不是改 REA 配置。
3. **连接不可用**：在 shell 里跑只读诊断 `npx -y rea-agents@latest doctor --json`，它不改配置。按报告区分「注册缺失／过期」「引擎缺失」「需要重连」。
4. **确实要修配置**：先给出只读计划 `npx -y rea-agents@latest setup --client … --dry-run --json`，把路径、备份与技能替换列给用户，得到同意后再执行。服务器已由应用内置注册，只有用户明确要求换一种注册方式时才走到这一步。
5. **超时**：主机超时不代表 REA 停止工作，证据仍留在它的账本里。用 `get_evidence_bundle` 或 `export_evidence_bundle` 取，而不是重放同一个调用。

不要重复执行同一个失败调用。不要为了「修好」而安装未被要求的软件、升级 Node 或改动用户的引擎安装。REA 支持 Node 22.23.4+、24.22.1+、26.12.1+，版本不符时如实告知用户，而不是自行升级。

## 会话生命周期

- 一次调查复用同一个 REA 会话与证据 ID；不要重复打开同一目标的多个会话。
- 打开的原生会话在调查结束时 `close_binary` 关闭。
- 需要长期留存的证据用 `export_evidence_bundle` 写到用户项目，导出后的包可以用 `rea inspect-evidence-bundle` 重新读取。
