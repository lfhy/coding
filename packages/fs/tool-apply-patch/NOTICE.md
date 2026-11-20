# 来源与许可

`src/index.ts` 中的 `APPLY_PATCH_LARK_GRAMMAR` 改编自 OpenAI [Codex `apply_patch.lark`](https://github.com/openai/codex/blob/main/codex-rs/core/assets/tools/apply_patch.lark)，上游以 Apache License 2.0 发布；完整条款见 [LICENSE.Codex](LICENSE.Codex)。本地版本保留补丁封套、新建与更新语法，移除文件删除和移动规则，并约束更新块为已有文件系统实现支持的形式。其余工具执行、路径准入与会话集成由本项目实现。本声明不改变上游材料适用的 Apache-2.0 条款。
