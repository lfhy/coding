# Motion recipes

This directory is an on-demand CSS reference, not a runtime library. Read this index first, then read only the recipe that matches the interaction you are implementing. Copy the relevant selectors into the owning CSS Module and adapt the token names; do not import this directory or add an animation dependency just to use a recipe.

| Recipe | Use it for |
| --- | --- |
| [`view-switch.css`](view-switch.css) | A sibling page, panel, or major view entering or leaving while the shell stays in place. |
| [`icon-feedback.css`](icon-feedback.css) | A semantic icon changing to success, loading, or attention, or a small icon-button response. |
| [`disclosure.css`](disclosure.css) | A disclosure row, accordion, or details panel opening and closing with a chevron. |
| [`list-stagger.css`](list-stagger.css) | A short list entering after a filter, navigation, or page change. |
| [`feedback.css`](feedback.css) | A compact toast, inline result, or success/error surface entering without shifting surrounding layout. |

## Adaptation contract

1. Use the product's existing CSS Modules, semantic tokens, easing, and duration variables; the `--motion-*` variables in these snippets are local extension points, not a second design system.
2. Keep the old view mounted until its exit animation completes when using `view-switch.css`; otherwise a CSS exit animation cannot be seen.
3. Use `transform` and `opacity` for movement where possible. Do not animate layout dimensions, large surfaces, or unrelated siblings merely to make a transition visible. The disclosure recipe is an explicit auto-height exception: it animates `grid-template-rows` while its inner wrapper clips overflow so the surrounding layout follows the content.
4. Keep a visible static state and an accessible name for every icon. Motion must reinforce state, never be the only state signal.
5. Preserve every recipe's `prefers-reduced-motion` branch. Reduced motion may remove decorative movement or shorten a transition, but it must not hide content or remove status feedback.

The snippets are original, token-oriented references maintained with this skill. Their organization is informed by [transitions.dev](https://github.com/Jakubantalik/transitions.dev), which publishes copyable CSS transitions, and the timing and choreography guidance in [LottieFiles/motion-design-skill](https://github.com/LottieFiles/motion-design-skill); no upstream code is vendored here.
