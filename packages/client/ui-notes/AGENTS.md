# AGENTS.md — 笔记页

本文件适用于 `packages/client/ui-notes`，补充[客户端规则](../AGENTS.md)。笔记页持有目录、标签和 Markdown 编辑；其他文件类型的内容区由所属编辑包通过子 slot 提供。

## 新增笔记支持的文件类型

新增或移除一种笔记文件类型时，按下面顺序改完再声明支持。只改菜单或页面里的扩展名判断，会出现“菜单能新建但打不开”“打开后保存到错误文件”或“助手读不到当前文件”。

1. **Host 准入**：[文件库](../../attachment/file-library/src/notes.ts)持有目录树、重命名和删除的类型准入。`NOTE_EXTENSIONS` 只用于 Markdown；结构化文件和工程目录要各识别自己的后缀与节点类型，不开放 `readNote`／`saveNote`。思维导图由 [`mindmap.ts`](../../attachment/file-library/src/mindmap.ts) 识别 `.codingmindmap`，幻灯片按 `NOTE_DECK_SUFFIX` 识别工程目录，Word 与 Excel 由 [`office-notes.ts`](../../attachment/file-library/src/office-notes.ts) 识别 `.codingword` 和 `.codingexcel`。可写内容在 Host 复用真实父目录校验、独占创建、私有权限、字节上限和目录同步。文件管理是否登记该类型由 `noteRecords` 决定。
2. **新建与保存**：合法内容由 Host 生成或校验后落盘，不由客户端先建空文件，也不绕过文件库直写笔记根目录。Markdown 导入复用 `notesCreate(name, directory, content)` 一次写入原文；幻灯片经 `/api/ppt/notes/{create,import}` 和 `fileLibrary.createNoteDeck` 建 `.codingppt` 工程目录，PPT 宿主在该目录写工程内容，不保留 `.pptx` 源稿或另建 `ppt/` 会话工程目录。导图经文件库 `/api/notes/mindmap/{create,import,read,edit}`，Word 与 Excel 使用[文件库的版本化办公笔记接口](../../../docs/subsystems/attachment.md#word-与-excel-文档快照)。两类的浏览器和助手入口各自复用同一服务；结构化写入与改名、删除走同一笔记写入队列。编辑按读取版本提交，HTTP 版本冲突返回 `409` 而不覆盖。
3. **打开分支**：同步 [`notes-tree.ts`](src/client/notes-tree.ts) 的 `noteKindOf`、`NOTE_ICONS`、`labelOf`、`filePaths` 和 `noteFiles`，以及 [`NotesPage.tsx`](src/client/NotesPage.tsx) 的恢复、切换、删除后选中、重命名保留扩展名和内容分流；目录和标签复用 `NOTE_ICONS`，结构化文档走 [`openStructured`](src/client/notes-ui-store.ts)，不进入 Markdown 草稿、自动保存和导出。只有会话没有活动文档时，目录轮询才自动打开助手新建的导图；修改已有导图由编辑器自行轮询。
4. **内容区 slot**：在 [`src/client/index.ts`](src/client/index.ts) 声明 `notes.document.<kind>` 子 slot，由所属编辑器包注册（幻灯片是 `ui-ppt-workbench`，导图是 [`ui-mindmap`](../ui-mindmap/README.md)，Word 与 Excel 共用 [`ui-office`](../ui-office/src/client/index.ts) 注册的 `notes.document.office`）。`NotesPage` 只选择 slot 并传递当前路径、显隐状态与编辑器区分文档所需的类型，不内联第二套编辑器。
5. **新建入口与文案**：在 [`NotesDirectory`](src/client/NotesDirectory.tsx) 的标题加号菜单下列出可新建和导入的类型，复用 `NoteNameDialog` 的名称和保存位置，更新 `locales.ts` 的中英文文案。目录右键菜单维持新建笔记、子目录及目录自身的操作。每种导入各有隐藏文件选择器，在 [`notes-import.ts`](src/client/notes-import.ts) 声明扩展名白名单和失败文案，复用 `runImport` 刷新目录并打开结果；不扩大其他入口的白名单。图标从 [ui-icons](../ui-icons/README.md) 使用语义名（`file-slides`、`file-mindmap`、`file-word`、`file-excel`），不内联 SVG。
6. **助手与预设**：同步 [`usePublishNotesTabs`](src/client/usePublishNotesTabs.ts) 和 [Host 标签协议](../../notes/tool-notes-tabs/README.md#发布协议)的 `activeKind`、扩展名和真实条目类型校验。目录初次核对后发布，标签改变即更新，10 秒心跳和同窗重挂载不回退版本。新类型需模型读写时只在[笔记预设](../../../apps/cli/config/agent-presets/notes/agent.cordis.yml)接入相应工具；无路径读取须核验唯一活动来源，不从目录猜测。
7. **文档与测试**：同步[本包说明](README.md)、[文件库说明](../../attachment/file-library/README.md)、[用户指南](../../../docs/user/guide/index.md#笔记)、[代码地图](../../../docs/map/hot.md#笔记目录)及所属编辑器、图标与工具说明。定向测试覆盖新建、导入限制、打开、保存或只读、版本冲突、重命名、删除、刷新恢复和路径校验；导图相关运行 `pnpm exec vitest run packages/client/ui-notes/tests packages/client/ui-mindmap/tests packages/attachment/file-library/tests packages/notes/tool-notes-tabs/tests`。客户端可见行为还需覆盖[真实装配用例](../../../apps/web/tests/notes-page.e2e.ts)及 `DSH_SNAPSHOT=replay pnpm run test:web`。

类型专属的内容区组件、创建函数和测试随类型一起新增，不塞进共享页面的条件分支。只把用户真正能执行的操作写进菜单、README 和用户指南：没有保存或生成链路的类型不能出现在“新建”里，也不能承诺可编辑。
