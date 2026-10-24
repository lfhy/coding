# Notification and project structure reference

This reference keeps pages consistent across a product. Adapt the names to the target stack, but keep the ownership boundaries and shared surfaces.

## Notification pattern

Use one shared notification primitive for transient feedback. The feature raises a semantic event such as `toast.success({ title, description })` or calls an injected notification service; the application shell owns the single `ToastViewport` and renders the queue. Feature pages do not create their own fixed notification container, duplicate toast styles, or render a transient success/error paragraph beside the action.

Use the surface by lifetime and scope:

| Situation | Surface |
| --- | --- |
| Brief confirmation that an action completed | Shared Toast, with concise product language and an optional next action. |
| A request failed but the user can continue elsewhere | Shared Toast with a product-language failure and optional retry action; never dump the raw request error into the page. |
| Recoverable field problem that must be fixed before submit | Field-level message next to the field, associated by `aria-describedby`. |
| Persistent failure or state that blocks the current task | Inline error in the owning panel, with a recovery action. |
| Destructive or high-consequence decision | Dialog or confirmation surface before the action; Toast may confirm the result afterward. |
| Background process with meaningful progress | Persistent task/status region, not a rapidly disappearing Toast. |

Never pass raw exceptions, response objects, stack traces, internal codes, implementation vocabulary, or request failures directly to a Toast or into page copy. Map the outcome to product language at the feature boundary. A request failure that only needs brief acknowledgement must use the shared Toast; do not render the raw error or a new inline error paragraph in the page. Keep an inline error only when the user must read it to recover, such as a field validation problem, a blocking panel state, or a persistent task failure with a recovery action. Do not use a Toast for content the user must keep reading, a validation message they must act on, or an error that disappears before recovery is possible.

The shared Toast primitive should own placement, stacking, timeout, pause-on-hover, close action, live-region politeness, reduced-motion behavior, and theme tokens. Tests should assert the user-visible message and action, not a page-specific CSS class.

## Layered interaction pattern

Use the smallest layer that preserves context. A short decision or short form belongs in a modal; a contextual detail view belongs in a drawer; sibling views belong in child Tabs. Do not put a long multi-section workflow into one tall modal. Use a step-based modal or wizard with one focused task per step, a visible Stepper, Back/Next controls, validation at the step boundary, and a final confirmation. Use child Tabs inside a drawer when the drawer contains several related detail views; keep the drawer contextual and do not turn each tab into a separate page. Shared Dialog, Drawer, Stepper, Tabs, Field, and Toast primitives own geometry, focus, keyboard behavior, and transitions; features own only step data, validation, and event mapping.

## Recommended reusable project structure

Use a small shared design layer and feature slices instead of one bespoke component tree per page. For multi-step forms, keep the step model and validation in the feature while rendering each step through shared Dialog, Stepper, Button, Field, and Toast primitives. For contextual detail, keep drawer navigation in shared Tabs and render feature panels inside the drawer; do not create a tall modal or a page-specific tab system.

```text
src/
  app/
    shell/                 # app layout, providers, shared ToastViewport
    routes/                # route composition only; no feature-specific primitives
  components/
    ui/                    # Button, Dialog, Input, Toast, Stepper, Tooltip, Tabs, icon wrapper
    feedback/              # Toast/notification service and status mapping
    layout/                # PageHeader, Section, Stack, SplitPane, responsive containers
    data-display/          # EmptyState, LoadingState, ErrorState, DataTable, StatusBadge
  features/
    <feature>/
      components/          # feature-specific composition built from shared UI
      hooks/               # feature behavior and notification mapping
      api/                 # transport/query adapters
      model/               # types, validation, state transitions
      index.ts             # the feature's public composition boundary
  styles/
    tokens.css             # semantic color, type, spacing, motion tokens
    globals.css            # reset and global primitives only
  assets/
    icons/                 # only approved custom/brand assets after library search
```

The exact directories may differ in a non-React or server-rendered project. Keep these rules: the shell mounts shared overlays once; shared UI owns geometry and interaction states; features compose those primitives; route files assemble features rather than reimplementing them; data/API code does not render UI; custom icons and notification mappings have one owner; and a new page must not introduce a second Button, Toast, Dialog, Stepper, Tabs, spacing scale, or icon wrapper.

If the project is small, start with `components/ui`, `components/feedback`, `features/<feature>`, and `app/shell`; split further only when a boundary has more than one consumer. Reuse is a contract: a component is shared because its behavior and visual rules are stable, not because every element must be abstracted prematurely.
