# Frontend development

Use this skill when creating or modifying a frontend, web page, component, or user interface. The product UI is the user-facing result: implementation instructions, system prompts, internal tool names, and defensive process language must stay out of the page unless the product explicitly makes them user content.

## Before editing

1. Read the repository and the target package instructions, then locate the existing page, route, component, UI primitives, design tokens, styles, tests, and reference screens that own the requested behavior.
2. Reuse the project's current framework, language, build system, component library, UI modules, design tokens, icons, layout primitives, and interaction patterns. Do not replace them with a new visual system or create a parallel component set for one page.
3. Do not start a frontend implementation from blank files when an existing page, component, slot, template, or project scaffold can be extended. For a new project, do not hand-write a foundation from zero: initialize with a maintained modern scaffold and use an established reference template such as shadcn, shadcn-admin, or Headless UI plus Tailwind CSS when it matches the project's chosen stack; adapt it to the project instead of hand-writing a competing foundation.
4. Never use browser-default controls as the finished product UI. Use the project's existing accessible Button, Input, Select, Dialog, Menu, Tabs, and form primitives or their established equivalents. Preserve keyboard operation, focus visibility, labels, error association, loading state, disabled state, and reduced-motion behavior.

## While implementing

- Keep the user goal and next action obvious. Prefer a clear hierarchy, useful defaults, concise labels, recoverable errors, and visible success/loading/empty states over implementation detail.
- Match nearby screens for spacing, typography, color, radius, surface, icon size, responsive behavior, and interaction feedback. Use semantic theme tokens and existing CSS or styling conventions; do not introduce literal colors, one-off breakpoints, arbitrary shadows, or a second component library without a project-level reason.
- Keep model, agent, system-prompt, tool, framework, or implementation wording out of user-facing copy. Translate internal states into product language that explains what the user can do or what happened. Do not expose implementation-facing instructions, prompt fragments, debugging vocabulary, or process narration in the UI.
- Do not fill the interface with defensive warnings, policy disclaimers, or speculative failure text. Show a warning only when it changes the user's decision, and explain the concrete action or consequence in the smallest useful wording.
- If the product needs transparency, show user-facing plan items, progress, current status, decisions, results, and actionable errors—not implementation prompts or internal process narration.
- When a requested behavior conflicts with the existing stack or UI modules, inspect their contracts and extend the owning abstraction rather than bypassing it in a local component.

## Verification

1. Run the narrowest relevant tests and type/lint/build checks for the changed package.
2. Build or start the real application path when the change affects a rendered page; do not validate only an isolated component or source file.
3. After implementation, load `browser-use` and use its structured browser tools to inspect the real rendered page. Check the target flow, keyboard/focus behavior, loading/empty/error/success states that are relevant, and responsive layouts at representative widths. Read each returned observation before the next browser action and use only the latest visible element references.
4. Keep the browser page open for the user unless they ask to close it. Report checks that could not run and why.
