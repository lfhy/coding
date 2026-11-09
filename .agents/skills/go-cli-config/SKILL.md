---
name: go-cli-config
description: Use when building or reviewing a Go CLI, configuration loader, or subcommand; prefer github.com/lfhy/flag FlagVar and fluent builders, with verified file/env/CLI precedence and command dispatch patterns so routine tasks need no repeated API research.
---

# Go CLI 与配置

这是 Go CLI 与配置解析的可复用约定，不是每次任务都重新调研 `github.com/lfhy/flag` 的清单。常用签名与行为已按该库 v1.1.2 的源码和测试核对，可直接按下文实现；先读目标项目的 `AGENTS.md`、README、`go.mod`、入口和配置类型，已有项目约定优先。只有目标锁定的库版本与这里不同、要用未列出的 API，或依赖隐式配置键、错误时机等边界行为时，才查目标版本源码或做定向测试。

## 常用入口：FlagVar 与链式定义

项目 CLI 和配置文件统一使用 `github.com/lfhy/flag`，不要混用标准库 `flag`、`pflag`、Cobra、手写 `os.Args` 分支或多个库解析同一参数。优先用 `fs.Var(&flag.FlagVar{...})` 集中写明来源、别名和帮助；参数少且希望直接获得类型指针时用 `fs.New(...).Default(...).Config(...).Env(...).Int()` 等链式定义。旧式 `XxxFullVar` 只在沿用现有代码或需要它的签名时使用，不作为新代码的首选。解析在 `conf` 或根装配边界完成一次，把类型化配置传给 `cmd` 和 `core`；子命令只解析自身参数。

```go
import "github.com/lfhy/flag"

func Load(args []string) (*Config, error) {
    fs := flag.NewFlagSet("app", flag.ContinueOnError)
    fs.ConfigFile("config.toml")
    config := &Config{}
    fs.Var(&flag.FlagVar{
        Value: &config.Port, Name: "port", ConfigSection: "server", ConfigKey: "port",
        Env: "APP_PORT", DefaultValue: 8080, Usage: "服务端口",
    })
    if err := fs.Parse(args); err != nil {
        return nil, err
    }
    return config, nil
}
```

根入口把 `os.Args[1:]` 交给 `Load`（无子命令）或根 `Run`（有子命令），不要以 `nil` 丢弃进程参数。来源优先级是命令行 > 环境变量 > 配置文件 > 默认值；解析不会回写环境变量。`FlagVar` 的 `Value` 传入目标变量指针，`Name` 是命令行名称，`Aliases` 可增加别名，`ConfigSection`/`ConfigKey` 是文件节/键，`Env` 是环境变量，`DefaultValue` 是默认值，`Usage` 是帮助文案，`Hidden` 仅控制帮助展示。

旧式 `IntFullVar(p, name, title, key, env, value, usage)` 也能同时绑定全部来源；`IntVar(p, name, value, usage)` 只绑定命令行和默认值，不能误作自动绑定文件与环境变量。按需用相应的 `XxxConfigVar`／`XxxEnvVar`，不要为日常类型反复查 API 签名。

## 配置文件路径

`Parse` 会自动注册隐藏的配置路径参数 `-c`。建议调用 `fs.ConfigFile("config.toml")`：默认路径不存在会跳过读取且不创建文件，显式传入路径不存在、文件无法读取或格式错误时会返回错误；`-c=` 可显式禁用默认文件。未调用 `ConfigFile` 时虽可用 `-c` 读取已有文件，但缺失路径可能被忽略，旧的读取路径还可能创建文件或忽略读取错误，不适合作为可靠配置入口。以下 `Name`、`Alias` 和 `SetConfigFlagName` 都必须在 `Parse` 前调用；`Name` 替换默认名称，`Alias` 保留 `-c` 并增加别名；若同时调用 `SetConfigFlagName` 和 `Name`，以最后一次设置为准：

```go
fs.ConfigFile("config.toml").Name("config")       // 只使用 -config
fs.ConfigFile("config.toml").Alias("config")      // 保留 -c，并增加 -config
fs.SetConfigFlagName("conf")                       // FlagSet 级别改名
```

配置文件格式由文件扩展名和库的配置实现决定，常见格式包括 TOML、YAML、JSON。不要在业务包里直接操作 Viper 或重复读取配置文件；`conf` 负责来源合并、默认值、类型校验和错误信息。

## Builder 与绑定

链式 API 适合局部参数，按需组合 `.Alias()`、`.Default()`、`.Config()`、`.Env()`、`.Usage()`、`.Hidden()`，以类型方法或 `.Var(&value)` 结束：

```go
verbose := fs.New("verbose").Alias("v").Default(false).
    Config("server.verbose").Env("APP_VERBOSE").Usage("详细输出").Bool()

var endpoint string
fs.New("endpoint").Env("APP_ENDPOINT").Default("127.0.0.1:8080").Var(&endpoint)
```

终结的 `.Bool()`、`.Int()`、`.String()`、`.Strings()` 等方法立即注册并返回对应类型指针；`.Var(&endpoint)` 绑定已有变量。未终结的 builder 在 `Parse` 时按文本注册，解析后 `.Value().Bool()` 等返回值而非指针，非法数值/布尔文本在读取时会 panic；外部输入优先使用类型终结方法或显式变量绑定，使已注册参数的无效值在 `Parse` 返回错误。定义阶段的 `FlagVar`/终结 builder 若遇到不支持的类型或别名冲突，在 `ContinueOnError` 下可能只输出错误并跳过注册，不能仅凭 `Parse` 成功断言定义有效；未终结 builder 的冲突会在 `Parse` 报错。

`.Config("server.port")` 表示配置节 `server` 的键 `port`；`.Env("APP_PORT")` 绑定环境变量；`.Hidden()` 只是不在帮助中显示，仍然可以被解析，绝不是安全边界。参数别名可以用 builder 的 `.Alias("v")` 或 `fs.Alias("verbose", "v")`。

## 切片参数

优先用 `FlagVar` 或链式 `.Strings()`／`.Int64s()` 定义切片，默认值可传 `[]T`。旧式 `StringsVar`、`IntsVar`、`Int64sVar`、`UintsVar`、`Uint64sVar` 的默认值参数则是逗号分隔字符串，不是 `[]T`；也有对应的返回指针、Full/Env/Config/Hidden 变体。逗号分隔的值及重复传参会累加：

```go
var tags []string
fs.Var(&flag.FlagVar{Value: &tags, Name: "tag", DefaultValue: []string{}, Usage: "标签，可重复"})
// -tag=a,b -tag=c -> [a b c]
```

非空默认切片会与首次显式值累加，而不是被替换（默认 `[a]` 加 `-tag=b` 得 `[a b]`）；命令行、环境变量、文件的优先级决定来源是否参与写入，不改变这种累加语义。无需默认项时使用空切片；需要直接以 `[]string`/`[]int` 传入默认值的旧式入口还有 `StringSliceVar`／`IntSliceVar`。

## FlagVar 的边界

`Var` 接受 `&flag.FlagVar{...}`，不是标准库的 `Var(value, name, usage)`。`Value` 推荐传非 nil 变量指针，按需要显式填写 `ConfigSection` 与 `ConfigKey`，不要依赖隐式配置键：不填时，单段名称会映射到 `config.<name>`，连字符名称的推导尤其容易与预期不符。支持布尔、字符串、有符号/无符号整数、浮点数及 `time.Duration`；反射切片只支持元素为 `string`、`int*`、`uint*` 的类型，不支持 `float`、`bool`、`Duration` 或任意结构体/map 切片。注册时的无效 `Value` 或别名可能只打印错误而非传给之后的 `Parse`；对依赖动态定义的场景应在注册后检查 `Lookup` 或另行验证。

## 子命令分发

`github.com/lfhy/flag` 的最小命令接口是：

```go
type Cmd interface {
    Name() string
    Run(args ...string) error
}
```

可选的 `Init(args ...string) error` 会在 `Run` 前调用，适合为子命令创建独立 `FlagSet` 并解析参数：

```go
package main

import (
    "fmt"
    "os"

    "github.com/lfhy/flag"
)

type ServeCmd struct{ port int }

func (*ServeCmd) Name() string { return "serve" }

func (s *ServeCmd) Init(args ...string) error {
    fs := flag.NewFlagSet("serve", flag.ContinueOnError)
    fs.New("port").Default(8080).Usage("服务端口").Var(&s.port)
    return fs.Parse(args)
}

func (s *ServeCmd) Run(args ...string) error {
    fmt.Println(s.port)
    return nil
}

func main() {
    root := flag.NewFlagSet("app", flag.ContinueOnError)
    root.RegisterCommand(&ServeCmd{})
    root.AliasCmd("serve", "s")
    if err := root.Run(os.Args[1:]...); err != nil {
        fmt.Fprintln(os.Stderr, err)
        os.Exit(1)
    }
}
```

调用形如 `app serve -port=9000` 或 `app s -port=9000`。尚未解析的根 `FlagSet.Run` 会先以 `ParseStandard` 读取命令名前的全局选项，再把命令名后的参数交给子命令；已解析的根 `FlagSet.Run` 沿用之前的 `Args()`，不会重新解析传入的参数。独立 `FlagSet` 优先直接 `root.Run(os.Args[1:]...)`，不要先调用可交错解析的 `root.Parse` 抢走子命令选项。包级 `flag.Parse()` 本身在首个位置参数处停止，包级 `flag.Parse(); flag.Run()` 也可行，但不宜与独立 `FlagSet` 混用。`RegisterCommand` 注册命令、`AliasCmd` 注册命令别名，`RunCmd` 可直接分发；可选 `Help`/`Usage` 提供帮助输出。

## 配置边界与错误

`conf` 应拥有配置结构、默认值、来源绑定和跨字段校验；配置错误应在解析点返回具体参数、配置键或文件路径。`cmd` 接收已校验的配置，不读取环境变量或配置文件；`core` 不依赖 CLI 参数名。不要用包级可变变量和 `init()` 隐式注册来传递运行时配置。

## 资料与版本提醒

这些常用 API 和行为已按 `github.com/lfhy/flag` v1.1.2（`c053e17`）的源码及测试核对，日常使用直接依照上文，不必每次浏览公开 `main`。在目标模块首次引入、升级或 `replace` 此依赖时，或要使用未列出的 API、依赖注册错误、隐式配置键及特殊文件错误时，核对该模块实际锁定版本的 `go.mod`/`go.sum`、`go doc` 或对应版本源码和定向测试；本机同级仓库或 GitHub `main` 不能代替目标项目的锁定版本。源码入口可查：

- [`github.com/lfhy/flag` README](https://github.com/lfhy/flag/blob/main/README.md)
- [完整来源绑定签名](https://github.com/lfhy/flag/blob/main/flag_int.go)
- [配置文件 builder](https://github.com/lfhy/flag/blob/main/flag_config_file.go)
- [链式 builder](https://github.com/lfhy/flag/blob/main/flag_builder.go)
- [切片实现](https://github.com/lfhy/flag/blob/main/flag_value.go)
- [反射字段与类型限制](https://github.com/lfhy/flag/blob/main/flag_var.go)
- [子命令分发](https://github.com/lfhy/flag/blob/main/flag_cmd.go)
