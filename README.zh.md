# Coding

[English](README.md) | 中文

Coding 是构建在 [DeepSeek AI](https://deepseek.com) 开发的 DeepSeek Harness（`dsh`）运行时之上的个人 AI 编程客户端。产品名、应用名和 Linux 命令均为 `Coding` / `coding`；内部 `@deepseek-ai/dsh` 包、插件、协议标识和 `$DSH_HOME` 数据保持与 DeepSeek Harness 运行时兼容。

它采用**一切皆插件**的架构，并由 [Cordis](https://github.com/cordiverse/cordis) 驱动，其设计参见论文 [_A Programming Paradigm for Spatiotemporal Composability_](https://github.com/cordiverse/paper)。

## 开发者预览

Coding 目前处于 _开发者预览_ 阶段，正在快速迭代。**未来将出现破坏兼容性的变更。**

## 客户端

| 平台 | 客户端 | 状态 |
| --- | --- | --- |
| macOS arm64 | 由本地 Node Host 驱动的 Coding 原生 GUI | 计划中 |
| Windows amd64 | 由本地 Node Host 驱动的 Coding 原生 GUI | 计划中 |
| Linux amd64 | 由本地 Node Host 驱动的交互式 `coding` 终端 UI | 计划中 |

桌面 GUI 会在原生 WebView 中复用现有 Web 界面。终端 UI 和 GUI 通过 `$DSH_HOME`（通常为 `~/.dsh`）共享会话、设置和凭据，并在可用时连接同一个本地 Host。发布产物会包含 Host 运行时，最终用户无需单独安装 Node。

## 运行

### 通过 `npm` 运行当前运行时

安装 `Node.js`，然后运行：

```sh
npx @deepseek-ai/dsh web
```

当前运行时命令默认会在 `http://127.0.0.1:3080` 启动 Web UI，本机启动时还会用默认浏览器打开页面。通过 SSH 启动时只打印宿主机 URL，因为本地转发地址由 SSH 客户端或编辑器持有。传入 `--no-open` 可仅运行服务器而不打开浏览器。详见 [Web UI 指南](docs/user/guide/index.md)。

### 从源码运行

如需从仓库源码运行：

```sh
git clone https://github.com/deepseek-ai/deepseek-harness.git coding
cd coding
pnpm install
pnpm run build
pnpm dsh web
```

`pnpm run build` 会准备仓库产物。`pnpm dsh web` 会直接使用这些已构建产物，不会重新构建。原生 Coding 桌面端与终端启动器的实施记录见 [TODO.md](TODO.md)。

## 社区与支持

- 欢迎通过 [GitHub Discussions](https://github.com/deepseek-ai/deepseek-harness/discussions) 提交反馈或 bug 报告。
- 为你的插件仓库添加 [`dsh-plugin`](https://github.com/topics/dsh-plugin) 话题，便于被发现。
- 欢迎加入 DeepSeek Harness 企微群：扫码添加企微小助手并填写入群问卷，完成后小助手会邀请你入群。

<table>
  <thead>
    <tr>
      <th align="center">企微小助手</th>
      <th align="center">入群问卷</th>
      <th align="center">微信公众号</th>
    </tr>
  </thead>
  <tbody>
    <tr>
      <td align="center"><img src="https://cdn.deepseek.com/harness/readme/community-wecom-assistant.png" alt="DeepSeek Harness 企微小助手二维码" width="180" height="180"></td>
      <td align="center"><a href="https://trtgsjkv6r.feishu.cn/share/base/form/shrcnIt5twSVdLGD52KJBckGCgg"><img src="https://cdn.deepseek.com/harness/readme/community-wecom-survey.png" alt="DeepSeek Harness 入群问卷二维码" width="180" height="180"></a></td>
      <td align="center"><img src="https://cdn.deepseek.com/harness/readme/community-wechat-official-account.png" alt="DeepSeek Harness 团队微信公众号二维码" width="180" height="180"></td>
    </tr>
  </tbody>
</table>

## 参与贡献

参见 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 开发

请先阅读[开发指南](docs/development.md)与[架构文档](docs/architecture.md)。

面向 agent：请遵循 [AGENTS.md](AGENTS.md)。

## 许可证

[MIT](LICENSE)

第三方依赖及其许可证见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
