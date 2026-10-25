---
name: kernel-driver-analysis
description: 内核驱动与系统组件的分析方法：Windows .sys 与 Linux .ko 的入口、设备对象、派遣表、IOCTL 与缓冲校验、回调与内存边界。目标是驱动模块或内核侧组件时加载。
---

# 内核驱动分析

驱动分析的价值集中在两件事：它暴露了什么接口，以及它如何处理来自用户态的数据。

## 先识别与元数据

确认格式（PE 或 ELF 可重定位目标）、目标系统与版本、架构、是否带签名。Linux `.ko` 的 `.modinfo`、`__versions` 与签名 trailer 用系统工具或 `list_strings`／`read_bytes` 读出来，属于元数据事实；读到的签名值不构成验证结论。压缩过的模块需要先用外部工具解压到单独的 `ET_REL` 文件再读，`inspect_binary_layout` 可以给出段、符号与重定位的确切位置。

Windows `.sys` 走原生分析路径：PE 资源用 `inspect_pe_resources`，导入表与加载配置要在 `open_binary` 之后用 `list_names`／`list_segments`／`read_bytes` 查。

## 接口面

按顺序梳理：

- 加载与初始化例程（`DriverEntry`、`module_init`），以及它创建的设备对象、符号链接、字符设备与主次设备号。
- 派遣函数或文件操作表（`IRP_MJ_*`、`file_operations`、`ioctl`）。
- 每个 IOCTL 或命令码：功能号、输入输出缓冲类型（`METHOD_BUFFERED`、`METHOD_IN_DIRECT` 等）、期望长度、对用户指针的探测与校验（`ProbeForRead/Write`、`copy_from_user`、`access_ok`）。
- 注册的回调：进程、线程、映像加载、文件系统过滤、网络过滤、电源管理。
- 与用户态共享的内存、事件、句柄表项。

## 风险判据

判断一次请求是否越界，看的是具体的校验与长度计算：整数溢出、截断后的长度比较、先读后查、检查了 `SystemBuffer` 却没检查实际复制长度、对用户提供的指针直接解引用。把这些点连同函数与地址列出，并说明触发它需要什么权限与调用序列。

## 边界

只做静态分析。不加载驱动、不安装证书、不在用户机器上触发内核路径，除非用户明确要求并且承担该风险；即使那样也要先说明可能造成的系统不稳定。对第三方驱动的结论限于识别与风险报告。

## 输出

模块身份与元数据 → 加载路径与设备接口 → 命令与 IOCTL 表（含校验实现）→ 回调与共享状态 → 风险点（函数、地址、触发条件）→ 未确认项。
