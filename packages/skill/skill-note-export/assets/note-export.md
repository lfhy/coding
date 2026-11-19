# 把笔记导出成 Word、PDF 或图片

用户要把笔记存成别的格式时按本文操作：产出默认放进用户主目录下的 `笔记导出` 目录，方便他在访达／资源管理器里直接看到，而不是埋在笔记目录里。导出只读原笔记，不改写、不移动、不重命名。

笔记页右上角的导出按钮由应用自己排版（黑体、KaTeX 公式、代码高亮都按界面渲染）。用户只想要文件、且指定「放到桌面或主目录」这类位置时，用下面的命令行管线；两条路都能走通时优先命令行产出，并说明与应用内导出的差异。

## 先定落点

```sh
out="$HOME/笔记导出"
mkdir -p "$out"
```

- 文件名用笔记标题，去掉 `/`、`\`、`:`、`*`、`?`、`"`、`<`、`>`、`|`；重名时追加 `-2`、`-3`，不覆盖已有文件。
- 写完把绝对路径告诉用户（例如 `/Users/姓名/笔记导出/项目周报.pdf`），让他能直接打开。
- 会话是 `workspace-write` 时只能改笔记目录和部分临时区，写 `$HOME` 会先被拒绝。被拒后按工具返回的提示，用同一条命令带 `sandbox_permissions`（更宽的模式）和一句理由重试一次：审批弹窗就是征求同意的步骤，升权只此一次，不能预先猜测，被拒就是最终结果。
- 用户不批准时退回笔记目录下的 `导出/`，说明文件在那里、以及为什么没放到主目录。

## 探测可用的转换工具

```sh
command -v pandoc && pandoc --version | head -1
for app in "Google Chrome" "Microsoft Edge" "Chromium"; do
  test -x "/Applications/$app.app/Contents/MacOS/$app" && echo "/Applications/$app.app/Contents/MacOS/$app"
done
command -v google-chrome chromium chromium-browser
command -v pdftoppm
```

- `pandoc` 负责 Markdown → `.docx` 与 Markdown → HTML；无头 Chrome／Edge 负责 HTML → `.pdf` 与 `.png`。
- 缺 `pandoc` 时不要用别的工具硬凑 Markdown 解析：直接告诉用户缺什么和安装命令（macOS `brew install pandoc`、Windows `winget install --id JohnMacFarlane.Pandoc`），并提示可以先用笔记页右上角的导出按钮。装软件要用户同意，不要自行联网安装。
- 找不到 Chrome 时同样如实说明；`pdftoppm`（poppler）只影响逐页出图，不是必需项。

## Word（.docx）

```sh
pandoc "$note" -o "$out/项目周报.docx" --from gfm+tex_math_dollars
```

- 标题层级、列表、表格、代码块与 `$公式$` 都会转成 Word 自己的结构（公式变 Word 公式）。
- pandoc 的 docx 用自带默认样式，正文字体不是黑体；用户要求黑体效果时，说明这一点并建议改用笔记页的导出按钮，或让他自己套用 Word 模板。不要为此现场拼一份 docx 模板。

## PDF（.pdf）

先把正文转成带样式的 HTML，再让无头 Chrome 打印成 PDF（文本可选、中文不缺字）：

```sh
css="$TMPDIR/note-export.css"
cat > "$css" <<'CSS'
body { font-family: "SimHei", "黑体", "Heiti SC", "PingFang SC", sans-serif; font-size: 15px; line-height: 1.7; max-width: 760px; margin: 0 auto; color: #1f2328; }
h1, h2, h3, h4, h5, h6 { line-height: 1.3; }
h1 { font-size: 26px; } h2 { font-size: 22px; } h3 { font-size: 18px; }
code { font-family: Consolas, "SFMono-Regular", Menlo, monospace; background: #f1f3f5; padding: 1px 4px; border-radius: 4px; font-size: 0.9em; }
pre { background: #f6f8fa; padding: 12px 14px; border-radius: 8px; overflow: auto; }
pre code { background: none; padding: 0; }
table { width: 100%; border-collapse: collapse; }
th, td { border: 1px solid #d0d7de; padding: 6px 10px; text-align: left; }
th { background: #f2f4f7; }
blockquote { border-left: 3px solid #d0d7de; color: #57606a; padding-left: 12px; margin: 12px 0; }
img { max-width: 100%; }
@page { size: A4; margin: 20mm; }
CSS
pandoc "$note" -s -o "$TMPDIR/note-export.html" --from gfm+tex_math_dollars \
  --metadata pagetitle="项目周报" --css "$css"
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --headless --disable-gpu --no-pdf-header-footer \
  --print-to-pdf="$out/项目周报.pdf" "file://$TMPDIR/note-export.html"
```

- 用 `--metadata pagetitle=` 只设置 PDF 的标题元信息。写成 `--metadata title=` 会在正文前多印一行重复标题。
- 公式转成 MathML 后由浏览器排版。个别 TeX 命令 pandoc 转不了，会打印 `Could not convert TeX math ... rendering as TeX` 并把源码留在 PDF 里；出现这条警告要告诉用户，并建议用应用内导出（KaTeX 渲染完整）。
- Linux 上把 Chrome 路径换成 `google-chrome`／`chromium` 的实际路径；`--no-pdf-header-footer` 在旧版本叫 `--print-to-pdf-no-header`，报未知参数时改用后者。
- 打印时 Chrome 会先输出一行 `bytes written to file …`；没有这一行就说明没写成，按错误处理，不要假设成功。

## 图片（.png）

三种都可用，按可用性挑一种：

```sh
# 1) 有 poppler：逐页出图，几页就是几张
pdftoppm -r 150 -png "$out/项目周报.pdf" "$out/项目周报"
# 2) macOS 自带 sips：只能转第一页
sips -s format png "$out/项目周报.pdf" --out "$out/项目周报.png"
# 3) 直接从 HTML 截整页（窗口高度要盖住内容）
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --headless --disable-gpu --hide-scrollbars --window-size=900,1600 \
  --screenshot="$out/项目周报.png" "file://$TMPDIR/note-export.html"
```

多页笔记用第 1 种，并把产出的文件名规则说清楚（`项目周报-1.png`、`-2.png`）。用截图方式时，内容超出窗口高度会被截断，宁可先估大高度或分成几张。

## 交付前核对

```sh
ls -l "$out"
```

确认文件真的存在、非空、扩展名正确，再向用户汇报绝对路径与格式。失败时说明是哪一步（缺 pandoc、找不到浏览器、写主目录被拒、Chrome 没有写出文件），不要用「已导出」掩盖失败，也不要把还没生成的文件说成已经生成。

## 与笔记页导出的差异

| 维度 | 命令行管线 | 笔记页右上角导出 |
| --- | --- | --- |
| 落点 | `$HOME/笔记导出`，用户能直接看到 | 浏览器下载目录 |
| 字体 | PDF 按样式文件（优先黑体），Word 用 pandoc 默认字体 | 固定黑体 |
| 公式 | pandoc → MathML／Word 公式，个别命令留源码 | KaTeX 渲染 |
| 代码块 | pandoc 高亮 | 应用主题色，导出为白底深字 |

用户要的是「和界面上看起来一样」时，走应用内导出；要的是「文件放到我能看到的地方」时，走命令行。
