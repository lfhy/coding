# List layout and data loading reference

Use this reference when a page's main content is a repeated collection: a data table, log, feed, inbox, or search-results list. It fixes the scrolling geometry first, then the rendering and loading strategy. Adapt class names and libraries to the target stack; the invariants do not change.

## Scroll geometry: the list owns the only scroll

The page occupies the full viewport and does not grow with its content. The header, search field, filter toolbar, and list actions are laid out outside the scroll region and keep their position while rows move. Only the list body scrolls.

```text
<section class="page">              height: 100dvh (or the shell's viewport height); display: flex; flex-direction: column; overflow: hidden
  <header class="page-header"/>     fixed height; does not scroll
  <div class="toolbar"/>            search, filters, actions; does not scroll
  <div class="list-viewport">       flex: 1; width: 100%; min-height: 0; overflow-y: auto; the only scroll container
    <div class="list-body"/>        sized by the virtualizer; rows positioned absolutely or by transform
  </div>
</section>
```

Rules that keep this geometry real:

1. The document must not scroll on a list page: the page root gets `overflow: hidden` (or the equivalent shell constraint), and no ancestor of the toolbar reintroduces `overflow: auto`. Scrolling the rows must not move the toolbar by a single pixel.
2. A flex or grid ancestor between the viewport-sized root and the scroll container needs `min-height: 0` (min-width for horizontal layouts); without it the child refuses to shrink below its content and the page silently becomes a document again.
3. Prefer `100dvh` on mobile web where browser chrome shrinks `100vh`; keep the product's shell-provided height when the app renders inside a fixed container instead of the viewport.
4. Do not simulate a fixed toolbar with `position: sticky` or `position: fixed` over a page-level scroll. Sticky is acceptable only inside the scroll container for a group header that belongs to the rows, never for the page toolbar.
5. A cell may clip or, for code and identifiers, scroll horizontally inside its own bounds; neither may widen the row, the list, or the page, and the vertical page scroll still belongs to the list viewport alone.
6. When the query, filter, or page changes, return the viewport to the top and move focus to the new first row when focus was inside the list.
7. Preserve keyboard scrolling: arrow keys, `Home`/`End`, `PageUp`/`PageDown`, and typeahead (when provided) operate on the list viewport, not on the document.

## Columns and row height: one line per row, never wider than the screen

The list fits the viewport width, and text never decides the layout. Every cell is a fixed budget that clips its content; a wrapped cell is a defect, not a fallback, because it changes one row's height, breaks the scan rhythm, and invalidates the fixed-height assumption virtualization depends on.

1. The page never scrolls horizontally: the page root keeps `overflow-x: hidden` (or the shell equivalent), the list width is `100%`, and no descendant may force a `min-width` wider than its column. When content does not fit, remove or hide a column instead of adding horizontal page scrolling.
2. Give every column an explicit budget: `table-layout: fixed` plus `<colgroup>` widths for tables, `grid-template-columns` or flex basis for custom rows. Order columns by priority: identity (name or title), status, key metadata, timestamps, low-priority metadata, actions. The identity column and the actions stay visible at every width.
3. Hide before squeezing. Below a media or container-query breakpoint, hide low-priority columns, either in CSS or through a persisted column chooser. Hidden values remain reachable in the row detail or drawer; never require horizontal scrolling to read a name.
4. Make truncation actually work: `min-width: 0` on every flex ancestor, `minmax(0, 1fr)` for grid tracks (plain `1fr` falls back to min-content and defeats the ellipsis), and `white-space: nowrap; overflow: hidden; text-overflow: ellipsis` on the truncating cell. Long unbroken strings such as paths and hashes follow the same rule inside a cell; `overflow-wrap: anywhere` belongs only in a multi-line detail view.
5. Keep one row height for the whole list: use one row-height token (for example 36px or 40px) and let no badge, avatar, tag, or button change it. Content that needs two lines or rich layout belongs in the row detail or drawer, not in the row. Uniform heights make fixed-size virtualization the correct and cheapest choice; do not switch to dynamic measurement because one cell wrapped.
6. Truncation hides characters, not information. Reveal the complete value through the shared Tooltip on hover and focus, keep it as the cell's accessible name, and provide copy or open-detail actions where the value matters. A name compressed to an ambiguous prefix needs a detail view that shows it in full, and an action or status label is never truncated to the point where the user cannot tell what it does.
7. Keep numerics and counts on one line: right-align numbers with tabular figures, give date and size columns fixed widths, and render a long tag set as one or two tags plus a `+N` control that opens the detail rather than a wrapping tag cloud.

## Rendering: virtualize the rows

Mount only what the user can see plus a small overscan. For content-stream rows that legitimately carry several lines, let the virtualizer measure them instead of guessing heights, and keep the scroll container and the sizing element it measures as the same node. Pick a stable row key from record identity, never the array index, so appending a page, resorting, or filtering does not reuse rows for different records.

Choose the mechanism by collection size and variability:

| Situation | Rendering approach |
| --- | --- |
| Bounded to well under a viewport of rows (a short static list, a menu) | Plain rendering; no virtualizer. |
| Fixed row height and potentially long | Fixed-size virtualization. |
| Variable row heights, potentially long | Dynamic-measurement virtualization, reserved for content streams such as logs or transcripts whose rows genuinely carry several lines; a list row that wrapped is a truncation defect to fix, not a case for measurement. |
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

In the running application: the document does not scroll, the toolbar is stationary while rows scroll, the DOM holds a bounded row count, the next page arrives before the end with visible loading and end states, a filter change resets to the top without duplicate rows, and returning to the list preserves position. At the narrowest supported width the page has no horizontal scroll, low-priority columns are hidden rather than squeezed, every row measures the same height, long names end with an ellipsis on one line, and the full value appears in the Tooltip on hover and focus. Confirm keyboard scrolling works within the list viewport.
