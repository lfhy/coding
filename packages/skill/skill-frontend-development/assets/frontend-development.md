# Frontend development

Use this skill when creating or modifying a frontend, web page, component, or user interface. The product UI is the user-facing result: implementation instructions, system prompts, internal tool names, and defensive process language must stay out of the page unless the product explicitly makes them user content.

## Before editing

1. Read the repository and the target package instructions, then locate the existing page, route, component, UI primitives, design tokens, styles, tests, and reference screens that own the requested behavior.
2. Reuse the project's current framework, language, build system, component library, UI modules, design tokens, icons, layout primitives, and interaction patterns. Do not replace them with a new visual system or create a parallel component set for one page.
3. Do not start a frontend implementation from blank files when an existing page, component, slot, template, or project scaffold can be extended. For a new project, do not hand-write a foundation from zero: initialize with a maintained modern scaffold and use an established reference template such as shadcn, shadcn-admin, or Headless UI plus Tailwind CSS when it matches the project's chosen stack; adapt it to the project instead of hand-writing a competing foundation.
4. Never use browser-default controls as the finished product UI. Use the project's existing accessible Button, Input, Select, Dialog, Menu, Tabs, and form primitives or their established equivalents. Preserve keyboard operation, focus visibility, labels, error association, loading state, disabled state, and reduced-motion behavior.
5. Design every primary flow to remain usable within one viewport (`100vh` or the product's viewport-safe equivalent). Avoid pages that become an unbounded vertical document; keep the main action and current context visible, put long content in the owning region's scroll area, and use responsive overflow rather than shrinking controls until they are unusable.

## While implementing

- Keep the user goal and next action obvious. Prefer a clear hierarchy, useful defaults, concise labels, recoverable errors, and visible success/loading/empty states over implementation detail.
- Match nearby screens for spacing, typography, color, radius, surface, icon size, responsive behavior, and interaction feedback. Use semantic theme tokens and existing CSS or styling conventions; do not introduce literal colors, one-off breakpoints, arbitrary shadows, or a second component library without a project-level reason.
- Use hierarchy intentionally: use child tabs for sibling views within a page, drawers for contextual detail or secondary editing, and modal dialogs for focused decisions or short forms. Keep each layer local, dismissible, keyboard-accessible, and sized to preserve the underlying context.
- Keep model, agent, system-prompt, tool, framework, or implementation wording out of user-facing copy. Translate internal states into product language that explains what the user can do or what happened. Do not expose implementation-facing instructions, prompt fragments, debugging vocabulary, or process narration in the UI.
- Do not turn secondary operations into another full page or an always-visible nested form. A create action must open a modal dialog (or an existing drawer when the flow genuinely needs more room); the page shows the create trigger, not the create form as a same-level content block. Use the least intrusive layer that fits the task: child tab for peer content, drawer for contextual work, modal for focused create/confirm flows.
- Do not fill the interface with defensive warnings, policy disclaimers, or speculative failure text. Show a warning only when it changes the user's decision, and explain the concrete action or consequence in the smallest useful wording.
- If the product needs transparency, show user-facing plan items, progress, current status, decisions, results, and actionable errors—not implementation prompts or internal process narration.
- When the user asks for a named visual direction ("make it look like Stripe", "cyberpunk dashboard", "glassmorphism", "brutal style") or the product needs a distinctive aesthetic, load the `stylekit` skill and follow its style spec: pick the exact slug, take its colors, tokens, and do/don't rules, then implement them with this project's existing components and theme layer. The spec guides the visual decisions; it does not replace product behavior, accessibility, or the project's own stack.
- When a requested behavior conflicts with the existing stack or UI modules, inspect their contracts and extend the owning abstraction rather than bypassing it in a local component.

## Verification

1. Run the narrowest relevant tests and type/lint/build checks for the changed package.
2. Build or start the real application path when the change affects a rendered page; do not validate only an isolated component or source file.
3. Check that the primary flow fits within the target viewport and that long content scrolls inside the correct region instead of creating an accidental full-page scroll.
4. Check that tabs, drawers, and modal dialogs create the intended hierarchy: a create trigger opens its form in a dialog or contextual drawer, rather than rendering the form beside the trigger at the same level.
5. When the change followed a `stylekit` style spec, compare the rendered result against that spec's tokens and rules, including computed colors, typography, spacing, borders, and the required interaction states.
6. After implementation, load `browser-use` and use its structured browser tools to inspect the real rendered page. Check the target flow, keyboard/focus behavior, loading/empty/error/success states that are relevant, and responsive layouts at representative widths. Read each returned observation before the next browser action and use only the latest visible element references.
7. Keep the browser page open for the user unless they ask to close it. Report checks that could not run and why.
