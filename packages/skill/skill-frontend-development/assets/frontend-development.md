# Frontend development

Use this skill when creating or modifying a frontend, web page, component, or user interface. The page is
a product surface: it tells a user their own situation and what they can do next. Nothing about how the
software was requested, planned, built, or verified belongs on that surface.

## Reading bundled files

Read a bundled file with the `skill_read` tool: `skill_read { "name": "frontend-development", "path": "examples/index.md" }`.
Paths are relative to this skill's resource root, never absolute and never containing `..`.

When the current host has no `skill_read` tool, fall back to the resource prefix shown in `<skill_resources>`: pass
that prefix verbatim plus the same relative path, for example
`${INTERNAL_SKILL_DIR}/coding-skill-frontend-development/examples/index.md`. The prefix already points at this
skill's `assets/` directory, so never append `assets/` a second time, and never resolve it with a shell command: it
is a workspace alias understood by the file tools, not an environment variable, so `ls` or `cat` on it reports
"not found".

## Non-negotiables

1. **Product copy only.** Never render system or developer instructions, prompts, skills, tool or model names,
   agent plans, task narrations, framework/library/package identifiers, file paths, internal URLs, raw JSON or
   schemas, code snippets that are not product content, stack traces, debug logs, build steps, acceptance
   criteria, or internal status labels. This covers headings, descriptions, placeholders, toasts, empty/error/
   loading states, tooltips, accessible names, alt text, and links. Translate failures into concise product
   language that says what happened and what the user can do. Only content the user supplied and explicitly
   asked to inspect may appear verbatim, in a dedicated code or content surface.
2. **One page, one job.** A screen answers one question: where is this person now, and what should they do
   next. If a requirement lists several capabilities of equal weight, deciding the focus is part of the task,
   not a detail to skip.
3. **No flat walls.** Three or more equal cards for items whose importance, content, or state differs is a
   defect. Current state becomes a band, peers become rows, reference becomes links. The single largest block
   on the screen is the one the user must read first.
4. **Reuse the project.** Work inside the existing framework, components, tokens, icons, and layout
   primitives. Do not replace the product's visual system or create a parallel component set for one page.
5. **No browser-default controls.** A bare `<input>`, `<select>`, `type="search"`, checkbox, radio, or date
   input is a defect, not a shortcut. A missing primitive is a task: add one shared component and use it
   everywhere.
6. **One viewport shell.** The page owns `100dvh`; only the list, panel, or detail body scrolls. The document
   never grows with data, and a list page never moves its toolbar.
7. **Verify what you shipped.** Render the real page in a browser, read the screenshot, and check hierarchy,
   leakage, viewport, and states before reporting done.

## Plan the page before the markup

Write a plan first. It lives in your reply or notes, never in the interface.

```text
Task:   <who> needs to <finish what> here, and knows they are done when <signal>.
Focus:  the one region that answers "where am I / what needs attention" is <region>.
Ladder: P0 <focus region> · P1 <where the work happens> · P2 <reference and links>.
```

Then rank every block into P0 (the user's current situation), P1 (the work and its primary action), and P2
(reference, comparisons, history). One P0 per screen. Choose one skeleton — hub, list/table, detail, settings,
wizard, dashboard — and keep it. A hub of several ways to do the same job is a header plus a current-state band
plus one row per way plus quiet reference links, not a row of identical cards.

Read [`information-architecture.md`](information-architecture.md) before composing a new page, and whenever a
finished page works but reads flat. It carries the tier rules, the demote ladder (card → row → link), the weight
ladder, the spacing scale, and the three defects with before/after examples.

## Hierarchy, layout, and space

- Set a weight ladder once and reuse it: page title 22–24px/600, region title 15–16px/600, item title 14–15px/500,
  body 13–14px/400, meta 12px muted. Adjacent tiers differ by at least 1.2×, or are clearly separated by weight
  and color; a 14px title over 13px body is not a hierarchy. Use the project's existing type scale when it has one.
- One filled primary action per region; secondary actions are outlined or quiet, tertiary actions are text links.
  Destructive actions take the danger color at the confirm step, not as the page's main visual.
- Use hierarchy intentionally: separate regions by 24–32px, groups inside a region by 12–16px, and related
  label/value pairs by 6–8px. Related things sit closer to each other than to anything else; if every block is
  equidistant, the page reads as one undifferentiated wall.
- Use child tabs for sibling views within a page, drawers for contextual detail or secondary editing, and modal
  dialogs for focused decisions or short forms. Keep each layer local, dismissible, keyboard-accessible, and
  sized to preserve the underlying context. Do not put a long multi-section workflow into one tall modal: split
  it into a step-based modal or wizard with one focused task per step, a visible step indicator, Back/Next
  controls, validation at the step boundary, and a final confirmation. Use child tabs inside a drawer when the
  drawer contains several related detail views.
- Do not turn secondary operations into another full page or an always-visible nested form. A create action must
  open a modal dialog (or an existing drawer when the flow genuinely needs more room); the page shows the create
  trigger, not the create form as a same-level content block.
- Compose a product surface, not a text poster. Use the existing icon library as visual anchors for navigation,
  actions, object types, and statuses; pair icons with concise labels when clarity needs text. Icons do not
  replace an accessible name. Avoid oversized hero headings, decorative paragraphs, slogan-like copy, ASCII or
  emoji art, and text blocks used as decoration where a control, icon, status, or data component would
  communicate the intent.
- Match nearby screens for spacing, typography, color, radius, surface, icon size, responsive behavior, and
  interaction feedback. Use semantic theme tokens and existing styling conventions; do not introduce literal
  colors, one-off breakpoints, arbitrary shadows, or a second component library without a project-level reason.
- Keep the user goal and next action obvious. Prefer a clear hierarchy, useful defaults, concise labels,
  recoverable errors, and visible success/loading/empty states over implementation detail.
- Do not fill the interface with defensive warnings, policy disclaimers, or speculative failure text. Show a
  warning only when it changes the user's decision, and explain the concrete action or consequence in the
  smallest useful wording.

## Copy

- Name things by the user's job, in their words: "Connected services", not the protocol name alone. A heading
  made only of acronyms is a feature list.
- Give every option one line saying what it is and who it is for. That line is the comparison; the acronym is
  only the label.
- One action, one verb, one object: "Create connection", not "Submit". The same action keeps the same name from
  trigger to confirmation.
- Empty, loading, and error states say what happened and what to do next, in the product's voice. They never
  explain how the product is built, and never show a raw error, stack, path, or log.
- If the product needs transparency, show user-facing plan items, progress, current status, decisions, results,
  and actionable errors — not implementation prompts or internal process narration.
- Before finishing, read every user-visible string once more, including fallback branches, errors, empty and
  loading states, tooltips, aria labels, and data-derived labels. If a phrase describes how the app is built
  rather than what the user can do, remove it or replace it with product language. Remove
  implementation-facing instructions, prompt fragments, debugging vocabulary, or process narration wherever
  they appear.

## Icons and controls

Treat the project's icon system as part of its component system. Inspect the public icon exports and semantic
mappings before adding visual controls. Prefer icons for navigation, actions, object types, statuses, and
repeated row or card anchors. Import through the supported public entry point; do not hand-draw or inline SVG,
use emoji or arbitrary Unicode as interface icons, or add a second icon library for one screen. If no suitable
library icon exists, use a familiar generic icon with a short label; only introduce a custom asset as a last
resort behind the project's icon abstraction or asset pipeline. When the surface genuinely needs an illustration
or a domain symbol the project lacks, do not invent it as a hand-written SVG: draw a base plate first with the
image tool (`generate_image`) at the final display size, viewpoint, stroke weight, and palette, inspect the
returned image, then rebuild it as a clean SVG behind the project's icon abstraction or asset pipeline, or ship
the raster asset. Without image tools, fall back to a library icon with a label and state that the illustration
is missing instead of hand-tracing paths. When the project has no icon library, read [`icon-library.md`](icon-library.md)
and use Lucide as the default recommendation.

Never ship a browser-default control. An unstyled or lightly styled `<input>`, `<select>`, `<textarea>`,
`<button>`, `<input type="search">`, `<input type="date">`, checkbox, radio, or color input is a defect:
`input type="search"` brings the platform magnifier, clear button, and rounded white box; `select` brings the
native arrow and native popup; checkboxes and radios bring the platform glyph. Use the project's accessible
Button, Input, SearchField, Select, Textarea, Dialog, Menu, and Tabs primitives, or their established
equivalents, so height, radius, border, surface, placeholder, focus ring, and disabled state come from the
theme. Preserve keyboard operation, focus visibility, labels, error association, loading state, disabled state,
and reduced-motion behavior.

A missing primitive is a task, not an excuse: when the project has no field, search, select, or textarea
primitive yet, add one shared component (see [`examples/fields/`](examples/fields/TextField.tsx)) and use it
everywhere. Only the project's own token-based component may reach the DOM as a control; a raw tag is acceptable
solely inside that shared primitive.

Route transient user notifications through the project's shared Toast or notification service. Do not add
one-off inline success/error banners, fixed alert boxes, browser `alert()`, or page-specific notification markup
for events that should briefly acknowledge an action. Keep persistent validation, blocking errors, and
task-relevant guidance in the owning surface; use Toast for short-lived global feedback and make it accessible
with the shared live-region and focus behavior. Read [`notification-and-structure.md`](notification-and-structure.md)
before introducing a new page, notification, empty state, or shared-looking component, and extend an existing
primitive or feature boundary instead of creating page-local copies of buttons, dialogs, Toasts, spacing scales,
icon wrappers, loading states, or error surfaces.

Do not start a frontend implementation from blank files when an existing page, component, slot, template, or
project scaffold can be extended. For a new project, do not hand-write a foundation from zero: initialize with a
maintained modern scaffold and use an established reference template such as shadcn, shadcn-admin, or Headless UI
plus Tailwind CSS when it matches the project's chosen stack; adapt it to the project instead of hand-writing a
competing foundation.

When the user explicitly names or clearly asks for a named visual direction ("make it look like Stripe",
"cyberpunk dashboard", "glassmorphism", "brutalist style"), load the `stylekit` skill and follow its style spec:
pick the exact slug, take its colors, tokens, and do/don't rules, then implement them with this project's existing
components and theme layer. The spec guides the visual decisions; it does not replace product behavior,
accessibility, or the project's own stack. When a requested behavior conflicts with the existing stack or UI
modules, inspect their contracts and extend the owning abstraction rather than bypassing it in a local component.

## Page shell, lists, and scroll

Every page owns the viewport: `height: 100dvh` (or the product's viewport-safe equivalent) on the shell,
`min-height: 0` on every flex or grid child between the shell and a scroll region, and `overflow: hidden` on the
shell itself. Only a list, table, log, transcript, or detail body scrolls; the document does not. Design every
primary flow to remain usable within one viewport. A page that grows taller with its data is a defect, not a
tradeoff.

Own the scroll in exactly one place: the list viewport. The page shell, header, search field, filter toolbar,
and list actions stay outside it and keep their position while rows scroll. Do not put `overflow: auto` on the
page, do not nest a second scroll container inside a row, and do not fake a fixed toolbar with `position:
sticky` over a page-level scroll. Give the viewport a real height through the layout chain and reset its scroll
to the top when the filter or query changes. On a list, table, log, inbox, or search-results page the document
itself must not scroll: the page owns the viewport, the header and the search and filter toolbar stay outside
the scroll container, and only the list body scrolls.

Treat long collections as virtualized and incrementally loaded regions. Render only the visible window plus a
small overscan once the collection can exceed a viewport of rows, and load the next page from an end-of-list
sentinel or the virtualizer's visible range near the end instead of fetching everything up front. Reuse the
project's existing virtualization, query, and pagination primitives; if none exist, add one product-wide
virtualizer rather than a per-page scroll workaround. A page-scrolling list, an unbounded mounted row count,
and a full collection fetched before the first screen are defects, not acceptable tradeoffs. Read
[`list-scroll.md`](list-scroll.md) before building or fixing a list page: it also carries the list page you
should verify (bounded DOM rows, the next page loads before the end with visible loading and end-of-list
states, a filter change returning the list to the top, appended pages preserving scroll and focus).

Keep the list inside the viewport width with uniform, single-line rows. Keep rows one line and one height:
long names, titles, paths, and emails end with an ellipsis inside their column instead of wrapping, every row
in the list has the same height, and the page never scrolls horizontally. When the columns do not fit, hide
lower-priority ones by breakpoint or a column chooser and keep the identity column and row actions visible;
never solve a width problem by wrapping a cell, letting the table widen the page, or squeezing a column below
legibility.

Align every row on one vertical center. Use one grid template and a fixed row height with `align-items: center`;
every cell is a flex row whose children are centered, leading dots and avatars sit in fixed-size boxes, chips
are inline flex with their own line height, and numbers use tabular figures. Header cells reuse the same
template and alignment. A cell that drifts high or low — typically a badge inheriting the row's line height, or
a flex row left at `flex-start` — is a defect; read [`list-scroll.md`](list-scroll.md) "Row alignment".

Bound each card or panel list: `min-height: 0` plus `overflow: auto` inside the card, a fixed or clamped height
that matches its sibling panel, single-line rows, and a "View all" action that opens the full set in a dialog, a
drawer, or an expanded panel with its own scroll area. Keep the page height equal to the viewport at any row
count. Starting point: [`pages/dashboard-page.tsx`](examples/pages/dashboard-page.tsx).

## Motion

Design motion as part of the interaction contract, not decoration. Do not hard-cut between sibling pages or
major same-page states when the existing stack can preserve context and animate the change. Prefer the project's
CSS Modules, motion tokens, `transition`, and `@keyframes`; use JavaScript animation only when CSS cannot express
the required gesture or physics. Keep the transition short, directional, and tied to the state change so focus,
content hierarchy, and the next action remain clear.

Use restrained micro-interactions for icons and controls when they clarify cause and effect: rotate or translate
a chevron on disclosure, give a status icon a subtle state animation, and animate add/remove or success/error
feedback without shifting unrelated layout. Do not animate every icon, use perpetual motion for decoration, or
make an icon animation the only state signal. Preserve stable layout and avoid animating large areas,
`width`/`height`, or other layout-triggering properties when `transform` or `opacity` is sufficient. Every motion
recipe keeps its `prefers-reduced-motion` fallback. For a starting point, read
[`motion-recipes/index.md`](motion-recipes/index.md) and copy only the matching CSS recipe.

## Copyable examples

[`examples/index.md`](examples/index.md) indexes reviewed shapes for the surfaces that drift most: child tabs, a
modal dialog, a shared Toast, form fields, an auth page, a settings page whose "change password" form lives in a
dialog, a list page whose header and toolbar stay put while the body scrolls, a dashboard whose panels own their
scroll, and a hub page whose focus band and entry rows replace a wall of equal cards. Copy the matching example
into the project's shared UI layer, map its `--ui-*` seams onto the product's semantic tokens (light and dark),
and keep its ARIA and keyboard wiring exactly as written. One shared copy per concept: a page imports it, it
never restates it. A copyable example is not a library to vendor wholesale; it is the shape of a decision.

## Verification

1. Run the narrowest relevant tests and type/lint/build checks for the changed package.
2. Build or start the real application path when the change affects a rendered page; do not validate only an
   isolated component or source file.
3. Read the rendered screen as a stranger. In the screenshot, can you tell within one second what the page is
   for, what is happening now, and what to do next? Desaturate it: the reading order must survive without color.
   At 25% zoom, is the largest block the most important one? If three blocks look interchangeable, the page is
   flat: make the current state a band and demote the rest to rows.
4. Check the weight ladder in the running page: the page title, region titles, item titles, and actions must be
   distinguishable, with one filled primary action per region and no second filled button competing with it.
5. Check that the primary flow fits within the target viewport and that long content scrolls inside the correct
   region instead of creating an accidental full-page scroll. Fill the page with a few hundred rows and confirm
   `document.documentElement.scrollHeight` stays equal to the viewport height. On a list page, confirm the
   document itself is not scrollable, the header and search or filter toolbar keep their position while the list
   scrolls, and the list viewport is the only scroll container.
6. Check row alignment at 2× zoom: a horizontal line through the middle of a row crosses the middle of every cell
   in it (dot, label, chip, timestamp, row action), and the header uses the same template. Then check the list's
   width and row rhythm at representative narrow and wide widths: no horizontal scroll, low-priority columns
   hidden instead of squeezed, every row reports the same height, long names ellipsized on one line, and the
   full value still reachable by hover, focus, or the row detail.
7. Inspect every control on the page in the running app: a platform-default search box, select arrow, checkbox
   glyph, date picker, or focus ring means the primitive was skipped. The field height, radius, border, surface,
   placeholder color, and focus ring must match the rest of the product, and a search field keeps its own clear
   action.
8. Check that tabs, drawers, and modal dialogs create the intended hierarchy: a create trigger opens its form in
   a dialog or contextual drawer rather than rendering the form beside the trigger at the same level.
9. Scan every visible string, including empty, loading, error, and disabled states, placeholders, tooltips, and
   accessible names, for implementation leakage: instructions, prompts, plans, framework or package names, file
   paths, raw errors, JSON, logs, and process narration. If any survived, replace it with product language.
10. When the change followed a `stylekit` style spec, compare the rendered result against that spec's tokens and
    rules, including computed colors, typography, spacing, borders, and the required interaction states.
11. After implementation, load `browser-use` and use its structured browser tools to inspect the real rendered
    page at two representative widths. Check the target flow, keyboard and focus behavior, loading/empty/error/
    success states that are relevant, and the responsive layout. Read each returned observation before the next
    browser action and use only the latest visible element references.
12. Keep the browser page open for the user unless they ask to close it. Report checks that could not run and why.
