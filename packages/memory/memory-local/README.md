# @deepseek-ai/dsh-memory-local

宿主文件系统上的 [`ctx.memory`](../memory/README.md) Provider：每个项目一个目录，记忆写成本地 Markdown。

## 存储布局

```text
<数据主目录>/memory/
  <md5(项目根真实路径)>/
    project.json      # { path, key, lastUsedAt }，本 Provider 的元数据，不是记忆条目
    notes.md          # 记忆条目，按小节组织
    decisions.md      # 需要分主题时的其他文件
```

目录以 `0700` 创建、文件以 `0600` 写入，写入走原子替换（`@deepseek-ai/dsh-atomic-write`），因此中断不会留下半个文件。`project.json` 记录项目真实路径，方便人确认这份记忆属于哪个项目；它是唯一的非 `.md` 文件，也不会出现在模型可见的文件列表里。

## 配置

```ts
export type Config = MemoryConfig
```

字段与默认值全部来自 [`@deepseek-ai/dsh-memory`](../memory/README.md)：`root` 省略时为 `<数据主目录>/memory`，其余是条目、单文件、每项目与文件数限额，以及注入预算。

## 边界

- **项目目录必须是真目录**：读写前用「记忆根真实路径 + 项目键」核对 `realpath`，目录被换成 symlink 时拒绝操作。比较刻意不用 `realpath(目录) === resolve(目录)`——macOS 的 `/var` 本身是指向 `/private/var` 的链接，那样会对任何临时目录误报。
- **只读 `.md`**：列表与读取都只认 `.md` 文件，其他文件（包括 `project.json`）不是记忆条目。
- **不做跨会话锁**：两个会话同时写同一个文件时，后写入的原子替换会让先写入的内容消失；记忆是笔记，不是事务存储。

## 模型体验

Indirectly, through [`@deepseek-ai/dsh-tool-memory`](../tool-memory/README.md) and [`@deepseek-ai/dsh-memory-context`](../memory-context/README.md)：本 Provider 不注册工具、不贡献提示词段，模型可见的只是它读写出来的记忆内容。

### KV Cache 影响

无直接效果：本包不改动请求内容，也不会在会话进行中重写已经进入历史的记忆文本。
