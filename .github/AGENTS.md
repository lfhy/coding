# AGENTS.md — GitHub Actions

The repository uses only [.github/workflows/ci.yml](workflows/ci.yml). It runs on GitHub-hosted Ubuntu runners and must stay credential-free: do not add API keys, publishing tokens, self-hosted runner labels, or deployment steps to this workflow. Keep release, desktop packaging, and real-provider tests in separate opt-in workflows when those products are ready.
