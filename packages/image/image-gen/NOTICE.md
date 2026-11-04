# 来源与许可

本包参考 [shanliuling/dsh-image-gen](https://github.com/shanliuling/dsh-image-gen) 的 Apache-2.0 授权实现，所参照版本为 commit `53589d2`。参考范围包括 `src/openai-compatible.ts` 对 OpenAI Images generations/edits 请求与 `b64_json`/URL 返回的处理方式，以及 `src/index.ts`、`src/canvas-state.ts` 的图像工具与画布状态需求。这里按照 Coding 的 Session 日志、持久附件、设置、凭据和 HTTP 信任机制原创改写，未复制上游源码、第三方素材、前端组件、预设或 provider 扩展，包源码按本仓 MIT 许可。上游拥有其项目及原始实现的版权；完整 Apache-2.0 授权条款见其[许可证](https://github.com/shanliuling/dsh-image-gen/blob/53589d2/LICENSE)。

本功能不提供上游的 ComfyUI、Google、DashScope、Seedream 或订阅图像接口，不装载原插件，也不声明与原作者有隶属关系。
