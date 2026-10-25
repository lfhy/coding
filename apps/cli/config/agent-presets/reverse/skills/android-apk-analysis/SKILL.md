---
name: android-apk-analysis
description: 分析 APK/AAB 的声明、组件、类与方法、JNI 边界、存储与加密、加固与签名。目标是 Android 应用包，或需要在 Java/Kotlin 与原生库之间追踪一个功能时加载。
---

# Android 应用分析

## 从声明开始

`inspect_android_package` 给出清单、permissions、导出组件（`exported` 的 Activity、Service、Receiver、Provider）、最小版本与目标 SDK。这些是确定的声明事实。接着从 `analyze` 结果里取类与方法清单、第三方 SDK 指纹和字符串里的域名、端点。

**声明不等于行为。** 代码里出现的域名只证明被引用；要证明访问，得找到实际使用该常量的请求构造点，或拿到运行时记录。导出的组件同理：能导出不等于被其他应用实际调用。

## 代码层追踪

功能追踪的顺序是：界面入口（Activity/Fragment/Composable）→ Java/Kotlin 调用链 → JNI 边界（`System.loadLibrary`、`RegisterNatives`、`native` 方法声明）→ `.so` 中的实现 → 最终效果（请求、文件、数据库行）。每一跳给类名、方法签名和证据位置；跨到原生层之后，地址证据来自原生分析工具。

Kotlin 协程、反射调用、动态代理和 `DexClassLoader` 会让静态链路断开。遇到这些要明确写下「此处动态分派，静态无法确定目标」，并给出运行时确认方案，而不是猜一个目标。

## 存储、加密与凭据

确认数据落在哪里：SharedPreferences、SQLite、内部或外部文件、Keystore、账号系统。取到数据库文件时用 `inspect_sqlite_database` 先读 schema 再选表。硬编码的密钥、IV、盐和混淆例程要给使用者所在的类与方法；说明数据在静态存储与传输中分别是否加密，各自证据是什么。报告风险，不要自行构造绕过。

## 加固与混淆

识别壳与保护通常依靠字符串与类指纹（如常见的加固厂商特征类、`libshella` 这类加载 stub）、异常的应用启动链、只在运行期加载的 dex。识别之后要写清静态可见范围、运行时可触达范围，以及继续分析需要什么前提。对用户自有应用做进一步处理是允许的；第三方应用只报告识别结果与建议。

## 签名与完整性

REA 6.7.0 没有专门的 APK 签名工具；`inspect_signature` 检查的是 Mach-O 的代码签名。要核对 APK 签名，用 `apksigner verify --print-certs` 一类的系统工具，或从 `META-INF` 与 APK Signing Block 里手工读取，并说明结论来自哪一种方案（v1 JAR、v2、v3、v3.1）、签名者证书指纹与轮换血缘。这些是身份与完整性事实，不是可信或正版判定；不要把指纹匹配说成「官方版本」，除非用户提供了可比对的基线。

## 输出

包身份与版本 → 声明事实（权限、导出组件、SDK）→ 与问题相关的代码路径 → 原生边界与 `.so` 证据 → 存储与加密结论 → 保护措施识别 → 未知项与需要的运行时验证。
