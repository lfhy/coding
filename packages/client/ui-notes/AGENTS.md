# AGENTS.md — 笔记页

本文件适用于 `packages/client/ui-notes`，补充[客户端规则](../AGENTS.md)。笔记页持有目录、标签和 Markdown 编辑；其他文件类型的内容区由所属编辑包通过子 slot 提供。

## 新增笔记支持的文件类型

新增或移除一种笔记文件类型时，按下面顺序改完再声明支持。只改菜单或页面里的扩展名判断，会出现“菜单能新建但打不开”“打开后保存到错误文件”或“助手读不到当前文件”。

1. **Host 准入**：[文件库](../../attachment/file-library/src/index.ts)持有扩展名与后缀真源。文件型条目把扩展名加入 `NOTE_EXTENSIONS`（目录树、改名、删除可见，同时决定 `readNote`／`saveNote` 能否读写）；目录型条目按 `NOTE_DECK_SUFFIX` 这类后缀识别，在 `notesTree` 里映射成自己的节点种类。可写内容另提供 `createNoteXxx` seam，复用 `safeNoteDirectory`、`O_EXCL`、私有权限、字节上限和父目录同步。`noteRecords` 决定该类型是否进入文件管理列表，需要列出时同步 `file-category.ts`。
2. **新建链路**：新类型的合法内容由所属 Host 服务生成，再经文件库落盘。幻灯片是目录型条目：`wire.ts` 的 `notesCreateSlide`／`notesImportSlide` → `/api/ppt/notes/create`／`/api/ppt/notes/import` → `PptProjects.createNoteDeck`／`importNoteDeck` → `fileLibrary.createNoteDeck` 建出 `{名称}.codingppt` 空目录，工程内容再由 PPT 宿主写进该目录。不让 Client 写空文件、不绕过文件库直接写笔记根目录，也不要恢复单文件 `.pptx` 源稿与 `ppt/` 会话工程目录。
3. **打开分支**：`notes-tree.ts` 的 `labelOf`、`filePaths`、`noteFiles`（助手写入检测）逐处判断；`NotesPage.tsx` 的恢复、切换、删除后选中、重命名保留扩展名和内容选择，`notes-ui-store.ts` 的打开动作，`NotesTabs.tsx` 的标签图标，`usePublishNotesTabs.ts` 的 `activeKind` 同步更新。Markdown 草稿、自动保存和导出只服务文本类型。
4. **内容区 slot**：在 `src/client/index.ts` 声明 `notes.document.<kind>` 子 slot，由拥有该编辑器的包注册（幻灯片是 `ui-ppt-workbench`）；`NotesPage` 只选择 slot 并维护可见路径，不内联第二套编辑器。
5. **新建入口与文案**：页头加号菜单、`NoteNameDialog` 的名称与扩展名处理、`locales.ts` 的中英文一起改；目录右键菜单只提供目录上的动作。菜单项使用 `ui-icons` 的语义图标（幻灯片用 `file-slides`），不内联 SVG。
6. **助手与预设**：`packages/notes/tool-notes-tabs` 的 `activeKind` 联合、扩展名白名单和“kind 与扩展名一致”校验要认识新类型；模型需要读写该类型时，在 `apps/cli/config/agent-presets/notes/agent.cordis.yml` 挂载对应工具。
7. **文档与测试**：同步本包 README、[文件库 README](../../attachment/file-library/README.md)、[用户指南](../../../docs/user/guide/index.md#笔记)和[代码地图的笔记目录](../../../docs/map/hot.md#笔记目录)；补 `packages/attachment/file-library/tests/notes.spec.ts`、`packages/client/ui-notes/tests`、`apps/web/tests/notes-page.e2e.ts` 及类型所属包的测试，覆盖新建、打开、保存或只读、重命名、删除、刷新恢复和越界路径拒绝。定向运行 `pnpm exec vitest run packages/client/ui-notes/tests packages/attachment/file-library/tests packages/notes/tool-notes-tabs/tests`；用户可见输出变化再跑 `DSH_SNAPSHOT=replay pnpm run test:web`。

类型专属的内容区组件、创建函数和测试随类型一起新增，不塞进共享页面的条件分支。只把用户真正能执行的操作写进菜单、README 和用户指南：没有保存或生成链路的类型不能出现在“新建”里，也不能承诺可编辑。
