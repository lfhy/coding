# AGENTS.md — 已归档 Agent Notes

类别目录中的归档 Agent Note 是冻结的历史快照，不是当前权威。封存后禁止编辑、重排、翻译、修复、删除或移动任何文件；新的决策与事实写入活跃 Agent Note 或当前文档。

归档变更接受两种输入形态：

- 新的中文 canonical 只移动 `foo.md`，并在 `Status: implemented` 后插入 `Archived: YYYY-MM-DD`。
- 历史 legacy pair 整体移动 `foo.md`、`foo.zh.md` 与 `foo.i18n.yaml`，在两侧插入同一归档日期并重新记录 sidecar。

除归档日期与历史配对 sidecar 的机械重录外，不修改正文。同步修复或删除活跃文档中的入站链接，不检查或修复归档记录的出站链接。

使用 [dsh-archive-agent-notes](../../skills/dsh-archive-agent-notes/SKILL.md) 工作流，并运行 `pnpm run verify-archived-agent-notes --write` 追加新文件 hash。普通验证器会拒绝已封存文件的改动或缺失、不完整历史三件套、未知类别目录和无效归档元数据。
