# dsh-home-paths

Coding 用户数据的共享文件系统路径辅助工具：主目录解析、环境变量优先级，以及首次启动从 DeepSeek Harness 遗留目录的自动迁移。

## 主目录

`resolveDshHome()` 解析 Coding 的单根主目录。优先级从高到低为：显式配置的路径、`$CODING_HOME`、`$DSH_HOME`、已有数据的 `~/.coding`、已有数据的 `~/.dsh`，最后是全新安装使用的 `~/.coding`。Coding 把所有用户数据（会话、设置、凭据、记忆）保存在同一根目录下。空目录不算“已有数据”：初始化中断留下的空 `~/.coding` 不会遮住 `~/.dsh` 里的真实数据。

`dshHomePath(...segments)` 使用 Node 的平台路径规则，将子路径段拼接到解析后的主目录下。不传入任何路径段时，返回主目录本身。

`dshHomeDisplay()` 以符号方式表示当前根目录，用于面向用户的路径：默认主目录表示为 `~/.coding`，遗留主目录表示为 `~/.dsh`，其他主目录按配置它的环境变量表示为 `$CODING_HOME` 或 `$DSH_HOME`。它绝不会泄露机器的绝对路径。

`isHomeDisplayPath(displayPath)` 判断模型可见路径是否落在主目录下。提示词生产者打印的主目录写法由本包拥有，识别自身用户全局路径的消费方（例如 `agent-instructions`）应问这里，而不是硬编码某一种写法。

`CODING_HOME_DIR_NAME` 是默认用户数据目录名 `.coding`，`LEGACY_DSH_HOME_DIR_NAME` 是遗留目录名 `.dsh`；`defaultCodingHome()` 与 `legacyDshHome()` 分别把操作系统主目录与这两个名字拼接（都可传入自定义 home，便于测试）。

`expandHomePath()` 使用操作系统主目录展开 `~`、`~/...` 和 Windows 风格的 `~\...` 前缀。它会保留非波浪号路径和 `~user/...` 原样不变。

## 首次启动迁移

`migrateCodingHome()` 在首次启动时把有数据的 `~/.dsh` 复制到 `~/.coding`，让老用户不用手工搬数据。它只读旧目录，绝不修改或删除：副本先落在同级暂存目录，按源目录的条目数与字节数校验后原子改名就位，因此中断或失败不会留下一个会被解析器优先选中的半成品主目录。成功后写入 `migration.json`（`migratedFrom`／`migratedAt`／`entries`／`bytes`）。

返回状态：`migrated`、`not-needed`（新目录已有数据或旧目录为空）、`explicit-home`（`$CODING_HOME`／`$DSH_HOME` 已指定主目录，本函数不插手）、`too-large`（旧目录超过 2 GiB 的自动迁移上限，留给手动迁移）、`failed`。除 `migrated` 外，`home` 都指向调用方现在应当使用的主目录；失败与超限都会回落到遗留目录，`resolveDshHome()` 的优先级本身也保证这一点。迁移不按条目数拒绝，旧目录中的运行时缓存、会话和设置会随一次迁移复制。

## 监听路径

`canonicalizeWatchPath()` 为原生文件系统 watcher 提供一种稳定的目标路径表示。它通过 `fs.realpath()` 解析层级最深的现有祖先路径，再拼回缺失的后缀，因此即使文件或目录尚未创建也仍可监听。尤其是，Windows 8.3 别名不能与原生 watcher 后端发出的长路径混用。

该包刻意保持规模小且不依赖 harness，以便产品包共享用户数据路径约定，而不必彼此依赖。

## 已知限制与暂缓事项

- **展开范围刻意保持狭窄**：只有单独的 `~`、`~/...` 和 `~\...` 使用当前操作系统主目录；`~alice/...` 等指定用户的形式、环境变量和 shell 表达式保持不变。
- **解析会读取目录，但绝不创建**：`resolveDshHome()` 只用同步 `readdir` 判断哪个主目录有数据；创建目录、权限与信任策略仍由调用方负责。
- **迁移不做去重合并**：`~/.coding` 一旦有数据就不再迁移，不会把两个目录的内容合并；需要合并时必须由人来做。
- **规范化会读取，但绝不修改**：`canonicalizeWatchPath()` 会执行 `realpath` 探测，并传播除路径不存在以外的错误；调用方仍负责目录创建、权限，以及对结果路径应用信任策略。
