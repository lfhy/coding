# 画廊界面来源与许可

画廊主页面的图库网格、筛选、卡片操作、批量管理、工作台与灵感详情参考并移植自 [shanliuling/dsh-image-gen](https://github.com/shanliuling/dsh-image-gen) commit `53589d2acb6cb4de67b59afab84248e768e63be8` 的 `src/client/gallery-view.tsx`、`studio-view.tsx`、`browser-image-utils.ts`、`inspiration-view.tsx` 与样式；兼容渠道默认尺寸见原项目 `src/studio.ts`。原项目由 shanliuling 按 Apache-2.0 授权；完整许可文本随本包的 [UPSTREAM_LICENSE](UPSTREAM_LICENSE) 保留。

本包将页面接到 Coding 的会话日志图库、同源图片路由、单一 OpenAI 兼容上游、主题 token 与 slot 机制；没有搬入原项目的多厂商选择、订阅登录或 tldraw 无限画布。收藏与隐藏是浏览器本地的逐会话视图偏好，不删除图片附件或持久会话事实。

灵感元数据快照取自原项目同一 commit 的 `awesome-gpt-image-2.json` 与 `handraw-style.json`。案例的 Prompt、标题和原始图片分别来源于固定 commit 的 [freestylefly/awesome-gpt-image-2](https://github.com/freestylefly/awesome-gpt-image-2/tree/c7d293963b21c60bf338003915438cc5c39dd3ca) 与 [yang0/handraw-style](https://github.com/yang0/handraw-style/tree/50998b094866e22007001161bca12c892a3796b1)。`coding-image-gen/assets/inspiration/` 内只保留为快速预览生成的 320px WebP 缩略图；图片版权仍归各案例原作者，页面保留每个案例的来源链接，不随本项目的主许可证重新授权。
