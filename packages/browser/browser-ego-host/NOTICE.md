# 第三方来源与改造范围

本包移植 [Fisfzy/dsh-ego-browser](https://github.com/Fisfzy/dsh-ego-browser) v0.9.7、commit `50d3d8782521904af12157a0399bf563a8130299`（MIT，版权声明见原样保留的 [LICENSE](LICENSE)），其中嵌入 [CitroLabs/ego-lite](https://github.com/CitroLabs/ego-lite) 的 Linux CDP 移植与 ego-browser SDK（MIT，版权与嵌入依赖声明见 [上游第三方说明](THIRD_PARTY_NOTICES.upstream.md)）。本包保持 `runtime/ego-linux/`、`runtime/ego-browser/`、`bin/ego-cast-worker.mjs` 的原语言；`third-party/host/` 仅为审阅用原始 Host 核心快照，不参与导入或生产打包执行。没有移植上游 Web UI、扩展配对、login import 或 FFmpeg 安装服务；上游声明中这些能力不等于本包已提供或下载相应二进制。

本包本地改动：`runtime/ego-linux/src/tabs.mjs` 删除空空间回退全局 tab；`runtime/ego-linux/src/task-spaces.mjs` 强制 isolation mode 创建失败时 fail-closed；`runtime/ego-linux/src/paths.mjs` 支持显式 `EGO_LINUX_STATE_DIR`；`bin/ego-cast-worker.mjs` 增加仅本机 loopback `/api/frame?targetId` 单页 JPEG 快照供受控 Host 转发。新建的 `src/` 为 Coding 自有 Host 桥，按会话身份收口工具和 HTTP，不修改第三方原有许可。上游 `THIRD_PARTY_NOTICES.upstream.md` 中提到的 FFmpeg/GPL 是未移植下载机制的历史声明；本包默认只用 CDP，不分发 FFmpeg 可执行文件。
