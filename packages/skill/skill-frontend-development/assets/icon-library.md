# Icon library reference

Use this reference when a project does not already provide an icon system. It is a selection guide, not a reason to install a second icon library or copy a third-party icon set into the project.

## Default recommendation

Use [Lucide](https://lucide.dev/guide) when there is no established project choice. Lucide provides a consistent 24px outline family, tree-shakable framework bindings, and official packages for vanilla web, React, Vue, Svelte, Solid, Preact, Angular, Astro, React Native, and static output. It is ISC-licensed and suitable for commercial and personal use; check the repository's current license and package documentation before publishing.

Choose the official binding for the project's framework, such as `lucide-react`, `@lucide/vue`, `@lucide/svelte`, `lucide-solid`, `lucide-preact`, `@lucide/angular`, `@lucide/astro`, or `lucide-static`. Keep imports tree-shakable and use the package's public exports.

## Alternatives

- [Phosphor](https://github.com/phosphor-icons/react) is a good choice when the design needs multiple weights or duotone variants. Use its official framework package and keep one weight system consistent within a product.
- [Tabler Icons](https://github.com/tabler/tabler-icons) is a good choice when breadth matters and the product needs outline and filled variants. Its icons use a consistent 24px grid; do not mix its stroke geometry casually with another family.
- [Heroicons](https://github.com/tailwindlabs/heroicons) is a good choice for a Tailwind project that already uses its React or Vue package and visual language.

These are alternatives, not a checklist. Select one family per product surface unless an existing design system explicitly defines a branded or specialized exception.

## Non-negotiable usage rules

1. Search the project's existing public icon exports and installed dependencies first. Existing project conventions take priority over this default recommendation.
2. Do not hand-draw or inline SVG icons when an equivalent icon exists in the chosen library. Do not replace a missing search result with a rough custom path, CSS shape, emoji, or arbitrary Unicode glyph.
3. If no suitable icon exists, first use a familiar generic icon with a short visible label. Only when the domain meaning genuinely requires a unique symbol should a custom asset be introduced, and it must live behind the project's icon abstraction or asset pipeline rather than being hand-written inside a feature component.
4. Use semantic names and a single size/stroke convention. An icon button needs an accessible name and tooltip; a decorative icon is `aria-hidden`; an icon must never be the only way to communicate a critical state.
5. Do not use a general UI icon family for product or company logos. Use the official brand asset or a dedicated brand-icon source and follow its license and usage rules.

Official references: [Lucide packages](https://lucide.dev/packages), [Tabler Icons](https://github.com/tabler/tabler-icons), [Phosphor Icons](https://github.com/phosphor-icons/react), and [Heroicons](https://github.com/tailwindlabs/heroicons).
