# Information architecture and visual hierarchy

Read this before composing a page, and again when a finished page "works" but looks flat. It decides
what the screen contains, in what order, and how strongly each part reads. Class names and breakpoints
belong to the target project; the decisions here do not.

A page is not a list of features rendered one after another. It is an answer to one question: what is
this person's situation right now, and what should they do next.

## 1. Decide the page before writing markup

Write these three lines before the first tag. They are a plan, not page copy, so they never appear in
the interface.

```text
Task:   <who> needs to <finish what> in this screen, and knows they are done when <signal>.
Focus:  the one region that answers "where am I / what needs my attention" is <region>.
Ladder: P0 <focus region> · P1 <where the work happens> · P2 <reference and links>.
```

If you cannot name the focus region, the requirement is still a feature list; stop and rank the
blocks first. If the plan has three P0 items, nothing is a P0.

## 2. Rank every block into three tiers

| Tier | What belongs there | How it reads | What it must never be |
| --- | --- | --- | --- |
| P0 focus | Current state, the active task, the latest result, the blocking problem | One region, full width or a wide column, the largest title-and-value mass on the screen | One of several identical cards |
| P1 work | The main action of the page and the objects it acts on: create, connect, choose, edit, filter | Clear region title, primary action, content in cards or rows | Pushed below the fold by P0 |
| P2 reference | Documentation, comparisons, history, related links, secondary settings | Compact rows, small headings, text links | A second wall of cards fighting P0 |

Rules:

1. Exactly one P0 region per screen. Two competing focus regions read as none.
2. P0 answers a question about the user's own situation, not about the product's feature set.
   "Which methods can I connect?" is P2; "I am connected through MCP and one skill failed" is P0.
3. A P2 block is allowed to be boring. Documentation links are links, not cards.
4. Promote by moving, resizing, and separating; do not promote by adding color or shadow to everything.

## 3. Choose one skeleton, then keep it

| Page type | Skeleton |
| --- | --- |
| Hub: the user picks among several ways to do one job | Header (title + primary action) → focus band (current state) → entry rows, one per way, each with a one-line "what it is / who it is for" → P2 links |
| List or table: scan and act on many objects | Header + toolbar (search, filter, primary create) → one scrolling list → row detail in a drawer |
| Detail: one object and its actions | Header with identity and status → actions → tabs for sibling groups (settings, history, logs) |
| Settings | Header → vertical child tabs → one section per tab, each with its own save or dialog |
| Wizard: a long flow | One step per view, visible stepper, Back/Next, validation at the boundary, confirmation at the end |
| Dashboard | Focus band of stats or alerts → panels that scroll inside fixed heights, each with "View all" |

Hub skeleton, which is what most "here are our N capabilities" screens actually need:

```text
┌ page header ───────────────────────────────────────────────┐
│ Access methods                        [ Create connection ] │  title + one primary action
├ focus band ────────────────────────────────────────────────┤
│ Connected 2 of 3 · last check 4 minutes ago                 │  the user's own state
│ ● HTTP API   active     ● MCP   active     ○ Skill  failed  │
│ [ Review failing skill ]                                    │
├ entry rows ────────────────────────────────────────────────┤
│ HTTP API   for servers that call us directly     Set up ›   │  one row per way, one-line explain
│ MCP        for desktop tools that host us        Set up ›   │
│ Skill      for editors that run our recipes      Set up ›   │
├ reference ─────────────────────────────────────────────────┤
│ API reference · Status page · Changelog                     │  links, not cards
└────────────────────────────────────────────────────────────┘
```

## 4. Demote before you add

Every block has three possible weights. When two items differ in importance, or one has far more
content than another, demote the quieter one instead of inventing a new layout for it.

| Weight | Shape | Use when |
| --- | --- | --- |
| Card | Bordered or elevated surface, 3–6 facts, its own action | The object is independent, the user acts on it here, and its content is larger than one line |
| Row | Fixed-height line in a shared container, identity + 1–2 facts + action | Peers compared at a glance, or a collection that may grow |
| Link | Inline text or a quiet button | Reference material, documentation, one-time destinations |

Rules:

1. A card grid with three or more equal cards is legitimate only when the items are genuinely
   parallel and compared by the user (pricing plans, machine sizes). Even then the page still needs
   its P0 band and one primary action, and the cards must not be the whole page.
2. Never render methods, integrations, capabilities, or connection options as a wall of equal cards
   when one of them is the user's current state. Current state is a band; the others are rows.
3. Do not nest a card inside a card inside a card. Two levels is the maximum: region surface, then
   item surface.
4. If a block's content is one sentence and one link, it is a row. Wrapping it in a card with padding
   and a border only makes the page taller and flatter.

## 5. Weight ladder

Set the ladder once per product, then reuse it. A page that has all five tiers is normal; a page that
sizes everything at two tiers looks flat, and a page with five similar sizes looks accidental.

| Role | Size | Weight | Color role | Spacing above |
| --- | --- | --- | --- | --- |
| Page title | 22–24px | 600 | primary text | 24–32px from the page edge |
| Region title | 15–16px | 600 | primary text | 24–32px between regions |
| Item title | 14–15px | 500 | primary text | 12–16px between groups |
| Body | 13–14px | 400 | primary text | 8–12px inside a group |
| Meta, caption, unit | 12px | 400 | muted text | 4–6px under its value |

Rules:

1. Adjacent tiers differ by at least 1.2× in size, or are clearly separated by weight and color.
   A 14px title above 13px body is not a hierarchy.
2. One or two emphasis levers per level. Bold + color + size + caps + uppercase tracking at once reads
   as noise, and a screen where everything is emphasized has no emphasis.
3. Exactly one filled primary action per screen region. Secondary actions are outlined or quiet, and
   tertiary actions are text links. Destructive actions take the danger color only where the
   destructive decision happens (the confirm step), never as the page's main visual.
4. Numbers that can be compared line up: same tier, tabular figures, right or decimal aligned.
5. Never make a label louder than the value it labels. The status is the content; "Status:" is not.

## 6. Spacing, grouping, and surfaces

| Relationship | Gap |
| --- | --- |
| Between page regions (P0 → P1 → P2) | 24–32px |
| Between groups inside a region | 12–16px |
| Between a title and its content | 6–8px |
| Between rows in one list | 0 (row padding and dividers own the rhythm) |
| Page edge to content | 20–32px, or the product's container padding |

Rules:

1. Related things sit closer to each other than to anything else. If two blocks are the same distance
   from each other and from their neighbours, they read as one undifferentiated wall.
2. Group with space and a shared surface before adding borders. A layout where every block has its own
   border and its own radius is the standard generated-card look.
3. Keep one radius for interactive controls and one for containers, one elevation model, and at most
   two shadow strengths. Do not give a card a shadow, a border, and a tinted background at once.
4. Ordering follows the user's sequence (see status → choose → work → reference), not the internal
   feature list. The most frequently used action sits in the first readable position, not last because
   it was implemented last.
5. Content width stays readable: forms 360–480px, prose 720–840px, wide data regions may fill the shell.

## 7. The three defects, and how to prove they are gone

| Defect | What it looks like | Check | Fix |
| --- | --- | --- | --- |
| Flat wall | Three or more equal cards for items whose importance or content differs | At 25% zoom, is the largest block the most important one? Do three blocks look interchangeable? | Make the current state a band; demote the rest to rows |
| No hierarchy | Page title, region titles, item titles, and actions all read at the same strength | Squint or desaturate the screenshot: can you still tell what to read first, second, third? | Apply the weight ladder, and reduce to one filled action |
| No organization | Blocks in implementation order, no grouping, no sense of a task flow | Write one sentence per region: "the user does X here." Any region you cannot describe is merged or deleted | Rank P0/P1/P2 and regroup by the user's sequence |

Worked example — the same content, before and after:

```text
Before: three identical cards, equal titles, equal buttons, no state
┌ HTTP API ──────┐ ┌ MCP ──────────┐ ┌ Skill ────────┐
│ base url       │ │ command       │ │ folder        │
│ [ Copy ]       │ │ [ Copy ]      │ │ [ Copy ]      │
└────────────────┘ └───────────────┘ └───────────────┘
(the page never says which one this workspace already uses, or what to do first)

After: one focus band, three comparable rows, one primary action, links for reference
Access methods                                   [ Create connection ]
┌ Connected 2 of 3 · checked 4 minutes ago ───────────────────────────┐
│ ● HTTP API active · ● MCP active · ○ Skill needs attention          │
│ [ Review the failing skill ]                                        │
└─────────────────────────────────────────────────────────────────────┘
HTTP API   Call us from your backend        Set up ›
MCP        Host us in your desktop tool     Set up ›
Skill      Run our recipes in your editor   Set up ›
API reference · Status · Changelog
```

## 8. Copy carries hierarchy

1. Titles name the user's task in their words ("Access methods", "Connected services"), not the
   system's structure or the protocol names alone. A heading made only of acronyms is a feature list.
2. Every option gets one line saying what it is and who it is for. The line is the comparison; the
   acronym is only the label.
3. One action, one verb, one object: "Create connection", not "Submit". The same action keeps the same
   name from trigger to confirmation.
4. Empty, loading, and error states say what happened and what to do next, in the product's voice.
   They never explain how the product is built, and never show a raw error, stack, path, or log.
5. Remove any sentence that describes the implementation. If a reader would ask "why is this here?",
   the answer belongs in the repository, not in the interface.

## 9. Before you finish

1. Cover the screen with one hand: the visible top third still says what the page is for and what is
   happening now.
2. Desaturate it: the reading order must come from size, weight, and space alone.
3. Count the filled buttons: one per region, and the rest outlined or quiet.
4. Shrink to a phone width: P0 stays first, rows stay one line, nothing scrolls sideways.
5. Read every visible string once more for implementation leakage, including placeholders, tooltips,
   empty states, and accessible names.
