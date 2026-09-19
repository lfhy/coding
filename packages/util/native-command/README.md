# dsh-native-command


一个**零依赖、免 Shell 的原生命令与路径打开库**。`runNativeCommand(command, args, signal)` 直接 spawn 可执行文件，捕获 UTF-8 stdout/stderr，把 abort 传播到子进程终止，并隐藏 Windows 瞬时控制台窗口。`openNativePath` 与 `openNativeTextFile` 在不接受 Shell 字符串的前提下把路径交给宿主桌面：macOS 使用 `open`，Windows 使用 PowerShell literal-path 调用，桌面 Linux 使用 `xdg-open`，WSL 则先经 `wslpath` 转换再调用 Windows 桌面。

消费方包括原生目录选择器、`dsh-host-apiproxy` 文件交接，以及 `dsh-host-open-in-app` 的应用发现和文件管理器启动。`NativeCommandRunner` 与 `PathOpenerRunner` 是可注入测试边界。

它是**库，不是服务或插件**：没有 `ctx`、不注册任何东西、不持有状态、不发事件。

## 接口面

```ts
import {
  canOpenNativePath,
  openNativePath,
  openNativeTextFile,
  runNativeCommand,
  type NativeCommandRunner,
} from '@deepseek-ai/dsh-native-command'
```

## 模型体验

无，因为这是宿主侧子进程管道，不会让任何内容进入模型请求。

#### KV 缓存影响

无；该包既不组装也不发送提供方请求。

## 已知限制与延后工作

- **不做输出限量**——两路流在内存中无界缓冲；当前每个调用方只运行输出为一个路径或一行错误的小型原生工具。把它指向输出量可观的命令之前，先接入 `dsh-output-retention` 限量。
- **浏览器选择刻意保持狭窄。** Linux 遵循 `$BROWSER`，macOS 读取 LaunchServices 的 HTTPS handler，Windows 依赖已注册文件关联；路径打开器不枚举应用。
