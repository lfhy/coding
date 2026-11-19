# coding-skill-note-export

随包分发 `note-export` 技能：把笔记导出成 Word（`.docx`）、PDF 或图片（`.png`）。插件依赖 `ctx.skills` 与文件系统路径别名，无配置；正文是 [`assets/note-export.md`](assets/note-export.md)，资源目录同时交给消费方定位。卸载即撤销登记。

技能把「产物落到用户看得见的地方」当默认：导出目录取 `$HOME/笔记导出`，文件名净化后不覆盖已有文件，完成后把绝对路径告诉用户。只读原笔记，不改写、不移动、不重命名。会话处于 `workspace-write` 时写主目录会先被沙箱拒绝，技能要求按升权提示申请一次，用户不批准就退回笔记目录下的 `导出/` 并说明原因，不允许把没写成的文件说成已导出。

转换管线是两条本机工具链的组合：`pandoc`（Markdown → `.docx`、Markdown → 带样式 HTML）与无头 Chrome／Edge（HTML → `.pdf`、`.png`）。逐页出图优先 `pdftoppm`，只有 macOS 自带工具时退回 `sips`（仅首页）或直接截图。技能要求先探测工具、缺 `pandoc` 时给出安装命令并征得用户同意，而不是自行联网安装或改用其它 Markdown 解析器。

正文还写明三条容易出错的细节：`--metadata pagetitle=` 只设 PDF 标题、写成 `title=` 会在正文前多印一行标题；Chrome 没有输出 `bytes written to file` 就说明没写成；pandoc 转不了的 TeX 命令会打印 `Could not convert TeX math ... rendering as TeX` 并把源码留在 PDF 里。最后用「命令行管线 vs 笔记页导出」对照表收口：要和应用内一致的渲染（黑体、KaTeX 公式、代码高亮）时走笔记页右上角的导出按钮。

## Model Experience

### 技能目录与正文

#### What the model sees

目录贡献的名称为 `note-export`，描述为：

> 把笔记导出成 Word（.docx）、PDF 或图片（.png）时使用：产物默认放到用户主目录的 `笔记导出` 目录，用户能在访达／资源管理器里直接看到；先用 pandoc 转格式、再用无头 Chrome 打印 PDF 或截图，逐页出图用 pdftoppm；导出只读原笔记，不改写不移动，写主目录被沙箱拒绝时按提示申请一次升权或退回笔记目录并说明位置。

被选择时加载的固定正文见 [`assets/note-export.md`](assets/note-export.md)。技能允许模型从目录加载，也允许用户显式调用。

正文四段：落点与文件名规则（含沙箱拒绝后的退路）；工具探测；按格式给出的可照抄命令与各自的坑；交付前核对与「命令行 vs 应用内导出」的差异表。示例使用管道与 `$HOME` 变量，可直接改名复用。

#### Token effect

启用后目录增加一项固定描述；仅在模型或用户加载该技能时加入正文。导出命令的输出、`ls -l` 结果与失败诊断都来自 Shell 工具，不由本包产生。

#### KV Cache effect

固定目录条目改变目录所在请求前缀；加载正文后，该轮请求增加固定指引。插件启用状态或目录成员变化可能改变前缀。

## Known Limitations and Deferred Work

- 技能只给操作步骤，不安装 `pandoc`、浏览器或 poppler，也不改变会话的沙箱策略与审批；缺工具或写入被拒时按正文给出的退路处理。
- 命令行产物的渲染与应用内导出不完全一致：Word 用 pandoc 默认字体（不是黑体），PDF 走 MathML，个别 TeX 命令留源码；需要与应用界面一致时用笔记页的导出按钮。
- 依赖 `pandoc` 的 GFM 解析：pandoc 不支持的 Markdown 扩展（例如笔记里应用独有的 `@文件` 提及）会按普通文本处理。
