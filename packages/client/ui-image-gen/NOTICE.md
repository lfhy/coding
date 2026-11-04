# 图像生成界面来源说明

本包参考 [shanliuling/dsh-image-gen](https://github.com/shanliuling/dsh-image-gen) 的 Apache-2.0 许可源码，来源版本为 commit `53589d2`。参考位置包括 `src/client/gallery-view.tsx`、`studio-view.tsx`、`tl/studio-tl-canvas.tsx`、`gallery-store.ts` 与 `index.tsx`：保留「会话画廊、创作入口、右侧画布、图片从画廊落入画布」的功能构想。此处的组件、数据请求和绘制逻辑按 Coding 的 slot、Host 路由及主题样式重新实现；未复制原项目 UI、tldraw／IndexedDB 画布、完整多供应商表单，也不引用原项目的 `@deepseek-ai/dsh-*` 依赖。

原项目版权所有者与许可见[原项目的 LICENSE](https://github.com/shanliuling/dsh-image-gen/blob/53589d2/LICENSE)。本包的原创适配代码按本仓 MIT 许可发布；没有复制上游源码或素材，不把上游 Apache-2.0 许可扩展为本包或其他包的许可声明。
