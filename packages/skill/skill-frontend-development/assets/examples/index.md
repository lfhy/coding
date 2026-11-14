# Copyable examples

The files in this directory are reviewed shapes, not a library to vendor wholesale. Read the one that
matches your task, copy its structure, keyboard behavior, and ARIA wiring into the project's own shared
component layer, then use the project's tokens and primitives.

| File | Copy when |
| --- | --- |
| [`tabs/`](tabs/Tabs.tsx) | a page or drawer has sibling views: child tabs, one panel at a time, horizontal or vertical |
| [`dialog/`](dialog/Dialog.tsx) | a focused decision or a short form must open over the page: create, rename, confirm, change password |
| [`toast/`](toast/Toast.tsx) | a transient success or failure needs to be acknowledged once, globally |
| [`fields/`](fields/TextField.tsx) | any form control: text field, search field, select. Never render a bare `<input>`, `<select>` or `type="search"` directly on a page |
| [`pages/auth-page.tsx`](pages/auth-page.tsx) | sign in, sign up, first-run administrator, reset password |
| [`pages/dashboard-page.tsx`](pages/dashboard-page.tsx) | a dashboard: 100dvh shell, stat cards, and panel lists that scroll inside the card instead of stretching the page |
| [`pages/settings-page.tsx`](pages/settings-page.tsx) | settings with several sections, including a "change password" action behind a button |
| [`pages/list-page.tsx`](pages/list-page.tsx) | a list or table page: fixed header and toolbar, one scrolling body, empty and loading states |
| [`pages/hub-page.tsx`](pages/hub-page.tsx) | a hub where the user picks one of several ways to do the same job: current state as a focus band, the ways as comparable rows, reference as links. Never a row of equal cards |

## Rules for using an example

1. Copy it into one shared place (`components/ui`, `shared/ui`, or the project's existing equivalent). Pages
   import from there; they never keep a private copy.
2. Replace every `--ui-*` custom property with the project's own semantic tokens. Keep the two token sets
   (light and dark) in the project's theme directory and let the components read only the variables.
3. Keep the ARIA wiring and keyboard handling exactly: `role="tablist"`, `aria-selected`, `aria-controls`,
   `role="tabpanel"`, `aria-modal`, focus restore, `Escape` to dismiss, and a polite live region for Toast.
   These are the parts that are hardest to add later.
4. Keep the geometry. Tabs replace only the content area; a dialog is sized for its task; an auth page is a
   single centered column of 360–480px; a list page never scrolls the document.
5. Delete what the task does not need. An example with more affordances than the task is a starting point,
   not a checklist.

## Token seams

The examples reference these variables so the copied code stays theme-neutral:

```css
:root {
  --ui-bg: /* page background */;
  --ui-surface: /* card and panel surface */;
  --ui-border: /* hairline border */;
  --ui-text: /* primary text */;
  --ui-text-muted: /* secondary text */;
  --ui-accent: /* primary action color */;
  --ui-radius: 10px;
  --ui-gap: 12px;
}
```

Point them at the project's real tokens (for this repository that means the `--dsw-alias-*` alias layer), and
provide a dark block in the theme directory rather than inside a component.
