# Agent Note: 个人客户端自动化基线

Status: implemented

## 问题

继承的 GitHub 与 GitLab 自动化假定存在组织自有 runner、发布凭据、GitHub Projects、文档部署和付费提供方账户。这些工作流无法可靠地验证个人 fork；在桌面端和 CLI 形成分发方案之前，它们会让普通源码改动排队、失败或消耗外部 API 额度。

## 决策

仓库只保留一个无凭据的 GitHub Actions 工作流。它的 `checks` job 只在推送 `v<version>` 发版 tag（例如 `v0.0.1`）时使用 Node 24 在 `ubuntu-latest` 上运行；该 job 安装锁定依赖，并针对该 tag 指向的源码执行 `pnpm run typecheck`、`pnpm run lint`、`pnpm run test` 和 `pnpm run build`。

fork 不保留 GitLab CI、Dependabot、Issue 生命周期自动化、文档部署、提供方 E2E、包发布、原生发布或 Python runtime 工作流。剩余的本地发布与平台脚本不是 CI 入口；只要对应源码仍需维护，它们仅作为本地工具或未来产品专用打包的基础保留。

桌面端打包、平台矩阵、代码签名、发布上传和真实提供方 E2E 必须等桌面壳、支持的操作系统、产物格式和凭据归属明确后，再以独立 opt-in 工作流加入。未来工作流只能在实际需要的步骤中使用凭据。

## 曾考虑的替代方案

**保留继承的 CI 矩阵。** 不予采用，因为它依赖不可用的组织 runner 与凭据，并验证本 fork 不会发布的包族。

**在每次 push 和 Pull Request 上运行基线。** 不予采用，因为日常开发使用针对性的本地检查和 Git 钩子；GitHub-hosted 基线只验证发版 tag 指向的源码。

**在创建桌面应用前先加入桌面发布自动化。** 不予采用，因为打包器、支持平台、签名方式和产物名称尚未选定。占位发布工作流只会形成另一项未被支持的接口。

## 后果

基线为共享运行时、CLI 和 Web Client 提供一个不依赖外部状态的可预测信号。它不证明原生桌面行为、Windows 或 macOS 可移植性、发布打包或真实提供方集成。只有对应的产品表面存在并拥有实现和分发目标时，这些检查才成为必需项。

较早的上游 Agent Note 仍可为保留代码提供历史设计输入，但不得作为本 fork 当前自动化策略的依据。本记录与 `.github/workflows/ci.yml` 共同定义当前策略。
