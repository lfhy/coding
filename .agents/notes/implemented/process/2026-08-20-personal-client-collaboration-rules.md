# Agent Note: Personal client collaboration rules

Status: implemented

English | [中文](2026-08-20-personal-client-collaboration-rules.zh.md)

## Problem

The fork is maintained primarily through agent-assisted work. Leaving finished task changes uncommitted makes the usable state depend on an untracked working tree, while mixed English and Chinese source comments make the local maintenance language inconsistent. Copying the reference client's Go rule literally would add comments that restate self-evident TypeScript, Python, or C code.

## Decision

Project-owned source comments and JSDoc written or changed with code use Simplified Chinese. They document non-obvious behavior, failure, ownership, timing, security limits, or module orientation; existing comments in the changed code area follow the same rule. Vendored, third-party, generated, license, protocol-literal, and user-visible text keeps its existing language.

After relevant verification passes, an agent creates one concise Chinese Git commit unless the user explicitly requests no commit. It stages only files belonging to the current task and never absorbs unrelated dirty worktree changes. A check blocked by external state or a confirmed unrelated timing failure is recorded in the handoff, while focused checks still cover the changed behavior.

## Alternatives considered

**Require a Chinese comment above every function.** Rejected because it would create restatements around straightforward code and weaken the useful comments.

**Keep English comments in Client packages.** Rejected because Client code is project-owned and should follow the same maintenance language as the rest of the fork.

**Leave commits manual.** Rejected because completed, verified work would remain easy to lose or mix with a later task.

## Consequences

The root and Client instructions share one comment-language rule without changing the language of public protocol data or third-party code. Each completed task leaves an isolated commit unless the user chooses a different handoff, and verification gaps remain visible rather than being hidden by the commit.
