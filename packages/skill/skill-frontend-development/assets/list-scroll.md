# List layout and data loading reference

Use this reference when a page's main content is a repeated collection: a data table, log, feed, inbox, or search-results list. It fixes the scrolling geometry first, then the rendering and loading strategy. Adapt class names and libraries to the target stack; the invariants do not change.

## Scroll geometry: the list owns the only scroll

The page occupies the full viewport and does not grow with its content. The header, search field, filter toolbar, and list actions are laid out outside the scroll region and keep their position while rows move. Only the list body scrolls.

```text
<section class="page">              height: 100dvh (or the shell's viewport height); display: flex; flex-direction: column; overflow: hidden
  <header class="page-header"/>     fixed height; does not scroll
  <div class="toolbar"/>            search, filters, actions; does not scroll
  <div class="list-viewport">       flex: 1; min-height: 0; overflow-y: auto; the only scroll container
    <div class="list-body"/>        sized by the virtualizer; rows positioned absolutely or by transform
  </div>
</section>
```

Rules that keep this geometry real:

1. The document must not scroll on a list page: the page root gets `overflow: hidden` (or the equivalent shell constraint), and no ancestor of the toolbar reintroduces `overflow: auto`. Scrolling the rows must not move the toolbar by a single pixel.
2. A flex or grid ancestor between the viewport-sized root and the scroll container needs `min-height: 0` (min-width for horizontal layouts); without it the child refuses to shrink below its content and the page silently becomes a document again.
3. Prefer `100dvh` on mobile web where browser chrome shrinks `100vh`; keep the product's shell-provided height when the app renders inside a fixed container instead of the viewport.
4. Do not simulate a fixed toolbar with `position: sticky` or `position: fixed` over a page-level scroll. Sticky is acceptable only inside the scroll container for a group header that belongs to the rows, never for the page toolbar.
5. A row may reveal a horizontal overflow region of its own only for content that genuinely exceeds the viewport (long identifiers, dense tables); the vertical page scroll still belongs to the list viewport alone.
6. When the query, filter, or page changes, return the viewport to the top and move focus to the new first row when focus was inside the list.
7. Preserve keyboard scrolling: arrow keys, `Home`/`End`, `PageUp`/`PageDown`, and typeahead (when provided) operate on the list viewport, not on the document.

## Rendering: virtualize the rows

Mount only what the user can see plus a small overscan. With unmeasured rows, apply the virtualizer's dynamic measurement rather than guessing heights, and keep the scroll container and the sizing element it measures as the same node. Pick a stable row key from record identity, never the array index, so appending a page, resorting, or filtering does not reuse rows for different records.

Choose the mechanism by collection size and variability:

| Situation | Rendering approach |
| --- | --- |
| Bounded to well under a viewport of rows (a short static list, a menu) | Plain rendering; no virtualizer. |
| Fixed row height and potentially long | Fixed-size virtualization. |
| Variable row heights, potentially long | Dynamic-measurement virtualization; measure once per key and cache the measurement. |
| Heterogeneous sections, grouped or sticky headers | Virtualization with group offsets; sticky group headers live inside the scroll container. |

Reuse the project's existing virtualizer if one is installed. If the stack has none, add a single product-wide dependency (for example TanStack Virtual, react-window, or the framework's equivalent) and wrap it in one shared list primitive; do not write a bespoke scroll-difference calculator per page and do not add a second virtualization library for one screen.

Accessibility survives virtualization: the sizing element exposes `role` and `aria-rowcount`/`aria-setsize` as appropriate, a virtualized row keeps its accessible name and focusability, and focus moving to an unmounted neighbor first scrolls it into view so the browser does not drop focus at the viewport edge.

## Loading: infinite scroll with bounded requests

Fetch the first page for the current filter, then load more as the end approaches; never load the entire collection to render its first screen.

1. Trigger the next page from a sentinel row at the list tail entering the viewport, from the virtualizer's visible range crossing the last loaded rows, or from an explicit "load more" control. Combine automatic loading with a manual control when the list is a primary task surface; pure automatic loading still needs a keyboard-reachable path to fetch more.
2. Keep one in-flight request per filter. Deduplicate concurrent triggers (IntersectionObserver fires repeatedly during momentum scrolling), cancel or ignore stale responses after the filter changes, and do not append a page twice when the sentinel re-enters while a request is open.
3. Append pages; never replace loaded rows with a loading state. Show page loading as a tail row or inline region, show retry inline when a page fails, and mark the true end with an explicit end-of-list indicator rather than silently stopping.
4. Reset pagination, scroll position, and selection when the query or filter changes. Keep the previously loaded pages and scroll position when the user returns to the list from a detail view.
5. Announce appended results through the product's shared live region for screen readers ("loaded 50 more"), not by moving focus.

If the product genuinely needs server-side paging controls instead of infinite scroll (audited exports, compliance views), keep the same scroll geometry and virtualized rows; only the fetch trigger changes to explicit navigation.

## Verification

In the running application: the document does not scroll, the toolbar is stationary while rows scroll, the DOM holds a bounded row count, the next page arrives before the end with visible loading and end states, a filter change resets to the top without duplicate rows, and returning to the list preserves position. Confirm keyboard scrolling works within the list viewport.
