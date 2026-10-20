---
name: go-cli-config
description: Use when building or reviewing a Go CLI, configuration loader, or subcommand; requires github.com/lfhy/flag for unified config-file, environment-variable, and command-line parsing, and covers its verified builders, slices, hidden options, aliases, and command dispatch APIs.
---

# Go CLI 与配置

这是本项目 CLI 和配置解析的指导，不是机械清单。需要新增或修改命令行参数、配置文件、环境变量、子命令或帮助输出时使用；先读目标目录的 `AGENTS.md`、README、现有入口和配置类型，仓库约定优先。

## 统一解析入口

项目 CLI 和配置文件必须使用 `github.com/lfhy/flag`，不要混用标准库 `flag`、`pflag`、Cobra、手写 `os.Args` 分支或多个库分别解析同一参数。解析应在 `conf` 或根入口的装配边界完成一次，得到类型化配置后传给 `cmd` 和 `core`；子命令只解析自身参数，不复制全局配置加载。

```go
import "github.com/lfhy/flag"

func Load(args []string) (*Config, error) {
    fs := flag.NewFlagSet("app", flag.ContinueOnError)
    fs.ConfigFile("config.toml")

    var port int
    fs.IntFullVar(&port, "port", "server", "port", "APP_PORT", 8080, "服务端口")
    if err := fs.Parse(args); err != nil {
        return nil, err
    }
    return &Config{Port: port}, nil
}
```

根入口把 `os.Args[1:]` 传给 `Load`、根 `Run` 或 `Parse`；示例的 `args` 不能替换成静默丢弃进程参数的 `nil`。来源优先级固定为：命令行 > 环境变量 > 配置文件 > 默认值。环境变量是只读输入，解析不会回写环境变量。

`IntFullVar` 的完整形状是 `IntFullVar(p, name, title, key, env, value, usage)`；它同时绑定命令行参数、配置文件的节/键和环境变量。不要把 `IntVar` 误写成自动绑定全部来源；按需使用库中对应类型的 `XxxEnvVar`、`XxxConfigVar` 或 `XxxFullVar`，并以锁定版本源码确认签名。

## 配置文件路径

`Parse` 会自动注册隐藏的配置路径参数 `-c`。显式传入 `-c path.toml` 时，文件不存在或无法解析应返回错误；通过 `fs.ConfigFile("config.toml")` 设置默认文件后，默认文件不存在可以跳过读取。配置路径可以在解析前改名或增加别名：

```go
fs.ConfigFile("config.toml").Name("config")       // 只使用 -config
fs.ConfigFile("config.toml").Alias("config")      // 保留 -c，并增加 -config
fs.SetConfigFlagName("conf")                       // FlagSet 级别改名
```

配置文件格式由文件扩展名和库的配置实现决定，常见格式包括 TOML、YAML、JSON。不要在业务包里直接操作 Viper 或重复读取配置文件；`conf` 负责来源合并、默认值、类型校验和错误信息。

## Builder 与绑定

链式 API 适合一组局部参数：

```go
verbose := fs.New("verbose").Alias("v").Default(false).
    Config("server.verbose").Env("APP_VERBOSE").Usage("详细输出").Bool()

var endpoint string
fs.New("endpoint").Env("APP_ENDPOINT").Default("127.0.0.1:8080").Var(&endpoint)
```

终结的 `.Bool()`、`.Int()`、`.String()` 等方法会立即注册并返回指针；未终结的 builder 可以在解析后通过 `.Value()` 读取，`Value().Bool()` 返回值而不是指针，并且非法文本转换会 panic。对外部输入优先使用类型终结方法或显式变量绑定，让解析错误在 `Parse` 返回，而不是把不可信文本留到业务流程中。

`.Config("server.port")` 表示配置节 `server` 的键 `port`；`.Env("APP_PORT")` 绑定环境变量；`.Hidden()` 只是不在帮助中显示，仍然可以被解析，绝不是安全边界。参数别名可以用 builder 的 `.Alias("v")` 或 `fs.Alias("verbose", "v")`。

## 切片参数

已确认的切片 API 是 `StringsVar`、`IntsVar`、`Int64sVar`、`UintsVar`、`Uint64sVar`。这些函数的默认值参数是逗号分隔的字符串，不是 `[]T`；逗号分隔值和重复传参会累加：

```go
var tags []string
var ids []int64
fs.StringsVar(&tags, "tag", "", "标签，可重复")
fs.Int64sVar(&ids, "id", "", "ID，可重复")
// -tag=a,b -tag=c  -> [a b c]
// -id=1,2 -id=3    -> [1 2 3]
```

示例使用空默认值以避免把默认项和显式项的累加语义混在一起。非空默认切片可能继续参与累加，不要声称第一次显式值必然替换默认值。

## 反射通用入口

反射入口是 `Var(&flag.FlagVar{...})`，不是标准库 `Var(value, name, usage)`。保守地传入非 nil 变量指针，并只使用已确认的字段：

```go
var ids []int64
fs.Var(&flag.FlagVar{
    Value:        &ids,
    Name:         "ids",
    DefaultValue: []int64{1, 2},
    Usage:        "ID 列表",
})
```

`FlagVar` 还支持参数别名、环境变量、配置节/键和隐藏标记。源码确认基础类型覆盖布尔、字符串、整数、无符号整数、浮点数和 `time.Duration`；切片只应按源码确认的字符串、有符号整数和无符号整数使用。不要宣传任意结构体、map、struct tag 或任意基础类型切片自动解码。

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
    fs.IntVar(&s.port, "port", 8080, "服务端口")
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

调用形如 `app serve -port=9000` 或 `app s -port=9000`。`FlagSet.Run` 在尚未解析时会使用 `ParseStandard`，在首个位置参数（命令名）处停止，把后续参数交给子命令；不要先用顶层 `FlagSet.Parse` 抢先解析子命令参数。命令注册使用 `RegisterCommand`，命令别名使用 `AliasCmd`，直接分发可使用 `RunCmd`。帮助输出可以通过可选的 `Help`/`Usage` 接口提供。

## 配置边界与错误

`conf` 应拥有配置结构、默认值、来源绑定和跨字段校验；配置错误应在解析点返回具体参数、配置键或文件路径。`cmd` 接收已校验的配置，不读取环境变量或配置文件；`core` 不依赖 CLI 参数名。不要用包级可变变量和 `init()` 隐式注册来传递运行时配置。

## 资料与版本提醒

以下链接用于核对 API；示例依据公开 `main`，项目必须以实际锁定版本的源码和测试为准，不要把未编译的网络示例当成兼容性承诺。

- [`github.com/lfhy/flag` README](https://github.com/lfhy/flag/blob/main/README.md)
- [完整来源绑定签名](https://github.com/lfhy/flag/blob/main/flag_int.go)
- [配置文件 builder](https://github.com/lfhy/flag/blob/main/flag_config_file.go)
- [链式 builder](https://github.com/lfhy/flag/blob/main/flag_builder.go)
- [切片实现](https://github.com/lfhy/flag/blob/main/flag_value.go)
- [反射字段与类型限制](https://github.com/lfhy/flag/blob/main/flag_var.go)
- [子命令分发](https://github.com/lfhy/flag/blob/main/flag_cmd.go)
