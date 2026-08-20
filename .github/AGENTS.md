# AGENTS.md — GitHub Actions

The repository uses only [.github/workflows/ci.yml](workflows/ci.yml). It runs after a `v<version>` release tag such as `v0.0.1` is pushed, on GitHub-hosted Ubuntu runners, and must stay credential-free: do not add API keys, publishing tokens, self-hosted runner labels, or deployment steps to this workflow. Keep desktop packaging and real-provider tests in separate opt-in workflows when those products are ready.
