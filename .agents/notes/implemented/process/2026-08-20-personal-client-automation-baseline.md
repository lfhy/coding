# Agent Note: Personal client automation baseline

Status: implemented

English | [中文](2026-08-20-personal-client-automation-baseline.zh.md)

## Problem

The inherited GitHub and GitLab automation assumed organization-owned runners, publishing credentials, GitHub Projects, documentation deployment, and paid provider accounts. Those workflows cannot validate a personal fork reliably and would make ordinary source changes queue, fail, or spend external API credits before the desktop and CLI products have a distribution plan.

## Decision

The repository has one credential-free GitHub Actions workflow. Its `checks` job runs on `ubuntu-latest` with Node 24 only when a `v<version>` release tag such as `v0.0.1` is pushed. It installs the lockfile and runs `pnpm run typecheck`, `pnpm run lint`, `pnpm run test`, and `pnpm run build` against that tag's source.

The fork does not carry GitLab CI, Dependabot, issue lifecycle automation, documentation deployment, provider E2E, package publication, native-release, or Python-runtime workflows. The remaining local release and platform scripts are not CI entry points. They stay available only while their source code still needs local maintenance or later product-specific packaging.

Desktop packaging, platform matrices, code signing, release uploads, and real-provider E2E require separate opt-in workflows after the desktop shell, supported operating systems, artifact format, and credential ownership are defined. A future workflow may use credentials only in the step that needs them.

## Alternatives considered

**Keep the inherited CI matrix.** Rejected because it depends on unavailable organization runners and credentials, and it validates package families that this fork is not publishing.

**Run the baseline on every push and pull request.** Rejected because daily development uses focused local checks and Git hooks; the hosted baseline is reserved for the source identified by a release tag.

**Add desktop release automation before creating the desktop application.** Rejected because the packager, supported platforms, signing model, and artifact names are not selected yet. A placeholder release workflow would only create another unsupported interface.

## Consequences

The baseline provides one predictable signal for the shared runtime, CLI, and Web client without external state. It does not prove native desktop behavior, Windows or macOS portability, release packaging, or real-provider integration. Those checks become required only when the corresponding product surface exists and has an owned implementation and distribution target.

Earlier upstream Agent Notes remain historical design input for retained code and must not be read as the current automation policy for this fork. This record and `.github/workflows/ci.yml` own the current policy.
