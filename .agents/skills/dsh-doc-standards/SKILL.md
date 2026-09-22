---
name: dsh-doc-standards
description: 'Use when writing, moving, reviewing, or auditing documentation in the deepseek-harness repo — choosing hierarchy and detail, separating tutorials from references, checking tutorial progression, trimming doc slop, or requests like "improve the docs", "audit the docs", "where should this be documented", or "this doc is too long".'
---

# Applying the DeepSeek Harness Documentation Standard

The documentation rules live in [docs/AGENTS.md](../../../docs/AGENTS.md). This workflow covers placement, corpus audits, budgets, and validation across Markdown, JSDoc, and code comments. It is guidance, not a script; use [dsh-prose-standard](../dsh-prose-standard/SKILL.md) for required coverage and editorial judgment, and never treat length alone as a defect.

## Sources of truth (read, don't re-summarize)

- [docs/AGENTS.md](../../../docs/AGENTS.md) — hierarchy, tutorial/reference forms, taxonomy, budgets, and slop checklist.
- [](../../notes/README.md](../../../docs/postmortem/README.md) — when an incident earns a postmortem.
- Root [AGENTS.md](../../../AGENTS.md) — the standing orders whose budget discipline this skill protects../../notes/archived/AGENTS.md) — frozen historical snapshots excluded from editorial maintenance and evolving documentation gates.

## Review structure before prose

Apply the standard's authoring order to every human-facing document in scope.Classify a postmortem as a reference scoped to one incident; preserve its required chronological evidence without treating chronology as a teaching sequence.

1. Locate the document in the repository and navigation trees. State its own subject and identify its direct children.
2. Set the permitted level of detail. Keep full detail about the document's subject, summarize direct children by purpose, responsibility, and high-level behavior, and move deeper explanations to their owning descendants with links. Treat test infrastructure as descendant-owned unless it is the document's subject.
3. Classify the document from its intended use, not its path or title. A tutorial must lead through ordered work to an observable outcome; a reference must support lookup within an explicit scope without requiring sequential reading.
4. For a tutorial, privately classify the starting reader and concepts as beginner, intermediate, or advanced. Trace each concept to its prerequisites, reorder premature material, and move optional advanced detail to a later tutorial or reference.
5. Split substantial mixed forms. Put a small secondary form in a clearly labeled section.

Then check constraints that make placement expensive or wrong:

- Ordinary authored docs use one Chinese `.md`. There is no English counterpart, no consistency record, and no language switcher; fully generated references stay in the generator's own language.
- Generated catalogs are never hand-edited; if the fact belongs there, change the generator's source.
- Before renaming or moving any doc, grep for inbound references yourself: no gate checks Markdown link targets, `#fragment` anchors, or `docs/*.md` citations in TypeScript comments. Search the old path and the old filename stem, including code comments and YAML comments.
- A move is atomic: remove from the old home, add to the new home, and fix every inbound link in the same change.

## Audit the corpus

After the structural pass, hunt the standard's slop checklist with the cheapest probes first. Verify and fetch the PR's live base, then run `pnpm --silent run change-scope --base <verified-base-ref>` to identify committed and dirty paths before applying semantic judgment. After a retarget or base merge, rerun the report and audit prose introduced by the new base.

1. Measure: `git ls-files '*.md' ':(exclude)vendor/**' | xargs wc -w | sort -rn | head -30` to spot oversized documents.
2. Hunt reasoning-transcript leakage — narrated history, dead design-session citations, review choreography, control-flow narration, test walkthroughs — with [dsh-trim-cot-leakage](../dsh-trim-cot-leakage/SKILL.md), which defines the taxonomy, recall batteries, and rules for what to keep or delete. Preserve only a non-obvious contract or durable rationale; the same rationale repeated beside sibling methods keeps one home.
3. Hunt duplication by grepping distinctive phrases. Keep one home and replace other copies with links.
4. Replace hand-written catalogs, test/status inventories, and JSDoc restatements with the authoritative tree, script, or generated reference.
5.Keep concise verification contracts that identify the behaviors and tiers pinning the shipped decision, plus named coverage gaps.
6../dsh-find-simplifications/SKILL.md)).

Exclude `` from corpus audits and edits.Active prose may repair, redirect, or delete an inbound link, but never follow an archive-wide cleanup into the frozen target.

Keep every load-bearing rule, preferably as one to three lines plus a link to its rationale. Cut stories, duplicates, status notes, and the path used to derive the rule. Do not create a new explanation merely to relocate disposable reasoning.

## Validation and PR hygiene

Follow the root [verification rule](../../../AGENTS.md#git-与-agent-工作) and always run `git diff --check`. Instruction-only prose needs no other check. When the change touches a generator or its generated reference, run that generator (`pnpm run gen-<name>`) and commit the regenerated output. Run `lint` only when code or lint configuration changed, and do not run broad gates in parallel when they build or consume shared artifacts. Report the checks actually run and any deliberate gap.
