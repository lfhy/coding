# coding-memory

项目隔离的跨会话记忆服务定义：把会话 cwd 解析成一个稳定的项目键，为每个项目维护若干 Markdown 记忆文件，并给消费方一套带限额的读写与摘要接口。

记忆落在数据主目录下的 `<home>/memory/<md5(项目根真实路径)>/`，因此它不进代码仓库、不随提交共享，只服务于「同一个项目、不同会话之间不要忘事」。存储由 Provider 实现（[`memory-local`](../memory-local/README.md)）；本包拥有键计算、文件名与限额策略、Markdown 条目格式和注入摘要渲染。

## 服务：`Memory`（ctx 键：`memory`）

`Memory` 是抽象服务类，Provider 继承它并实现四个存储原语（`listFiles`／`readFile`／`writeFile`／`removeFile`）。消费方只看到下面这些成员：

- `root`：记忆根目录的绝对路径，省略配置时为 `<数据主目录>/memory`。
- `projectFor(cwd)`：向上找到第一个带项目根标记（默认 `.git`）的目录，解析 symlink 后取 `md5` 作为目录键，返回 `{ path, key, directory }`。同一项目在任何子目录开会话都命中同一份记忆；没有标记时用 cwd 本身。
- `list(project)`：列出记忆文件（名称、首个标题、字节数、最近修改时间），最近修改的在前。
- `read(project, name)`：读取一个文件，超过单文件上限时只返回头部并置 `truncated`。
- `save(project, { content, file?, section? })`：把小节内容追加进目标文件（默认 `notes.md` 的 `要点` 小节），小节不存在时在文件末尾新建；写入前执行单条、单文件、每项目总量与文件数四项限额，任何一项越界都抛错，诊断里带实际数值。
- `remove(project, name, section?)`：删除整个文件，或只删除一个小节；删掉最后一个小节后只剩标题的空壳文件同样算清空并删除。
- `excerpt(project)`：渲染注入提示词的有界摘要（默认 4096 字节）：按最近修改排序，每个文件给 `### <文件名>` 与开头内容，用完预算为止；被截断或省略的文件列在返回值里，让消费方提示模型去读全文。

## 策略与限额

| 项 | 默认值 | 含义 |
| --- | --- | --- |
| 文件 | `notes.md` | 未指定文件时的目标文件；文件名必须是同一目录下的小写 `*.md` |
| 小节 | `要点` | 未指定小节时的目标小节 |
| `maxEntryBytes` | 8192 | 单条写入上限 |
| `maxFileBytes` | 65536 | 单个记忆文件上限 |
| `maxProjectBytes` | 1048576 | 一个项目的记忆总量上限 |
| `maxFiles` | 16 | 一个项目的记忆文件数上限 |
| `injectBytes` | 4096 | `excerpt()` 的字节预算 |
| `projectRootMarkers` | `['.git']` | 解析项目根时接受的目录条目 |
| `root` | `<home>/memory` | 记忆根目录 |

文件名只允许 `[a-z0-9._-]` 组成、必须以 `.md` 结尾且不含路径分隔符，因此消费方无法用文件名逃出项目目录。条目以 Markdown 列表项写入，多行内容缩进续行，人可以直接读这些文件。

## 消费方

- `coding-tool-memory`：`memory_save`／`memory_read`／`memory_list`／`memory_delete` 四个工具，参数里没有任何路径，目标目录由会话项目根决定。
- `coding-memory-context`：把 `excerpt()` 的摘要注入会话基线。

## 模型体验

Indirectly, through `coding-tool-memory` and `coding-memory-context`：本包自身不注册工具、不贡献提示词段，因此没有直接的模型可见文本。

### KV Cache 影响

无直接效果：本包不改动请求内容。摘要注入与工具结果的影响由上述两个消费方负责。

## 已知限制与暂缓事项

- **键是路径的函数**：项目改名或移动后 `md5` 会变，旧记忆不再命中；目录里的 `project.json`（由 Provider 写）记录真实路径，便于人工辨认与迁移，但不会自动重键。
- **不做并发合并**：`save` 是「读—改—写」，两个会话同时写同一个文件时后者覆盖前者；记忆是笔记而不是事务存储。
- **记忆不是安全边界**：所有项目的记忆同处一个用户主目录下，同机同用户的进程都读得到；不要往记忆里写凭据、密钥或个人隐私。
- **项目根探测用宿主文件系统**：这里用同步 `existsSync` 向上找标记，与工作区指令发现各自持有自己的走法——后者必须跟随 `ctx.fs` Provider，而记忆键只需要宿主可见路径。
