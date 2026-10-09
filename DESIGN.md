# Risulta design system

Risulta uses a quiet, data-first visual language for a focused analytics
product. The interface feels precise and fast: black and white
foundations, neutral grays, compact controls, strong typographic hierarchy,
and detail supplied by data rather than decoration.

## Principles

1. One page should answer the basic traffic questions without configuration.
2. Use spacing before separators, and separators before shadows.
3. Data is the accent. Avoid decorative gradients and saturated brand color.
4. Every view needs a useful empty state and a clear path to receiving data.
5. The dashboard is server-rendered. No client JavaScript is required.
6. Light and dark appearance follow the operating-system preference.

## Tokens

| Role | Light | Dark |
| --- | --- | --- |
| Canvas | `#ffffff` | `#000000` |
| Foreground | `#171717` | `#ededed` |
| Secondary text | `#666666` | `#a1a1a1` |
| Tertiary text | `#8f8f8f` | `#777777` |
| Structural line | `#eaeaea` | `#2e2e2e` |
| Subtle surface | `#fafafa` | `#111111` |
| Hover surface | `#f2f2f2` | `#1a1a1a` |
| Focus | `#0070f3` | `#52a8ff` |
| Live status | `#45a557` | `#45a557` |

Use `Geist`, then the native system UI stack. Body copy is `14px / 1.5`.
Display values use tabular numbers. Headings use slightly tight tracking.

Use an 8px corner radius for controls and 10px for restrained major panels. Nested
corners must be concentric. Structural cards use a 1px line; selected compact
controls use a small shadow for elevation.

## Layout

- Content width: `1120px` maximum with `24px` desktop and `16px` mobile inset.
- Header: `64px`, open spacing without a structural bottom border.
- Summary: three selectable metrics above one chart, with an open panel.
- Reports: two equal columns; collapse to one column when they stop fitting.
- Mobile metrics remain a compact three-column strip. Text and controls must reflow at 320px.
- Group gaps are at least twice their internal gaps.

## Components

- The Risulta mark is a single leaning leaf, a nod to Sproutboat: solid black,
  one cut vein, no gradient or color.
- Segmented controls sit on a subtle surface; the current item uses the canvas.
- Metric selection uses a subtle surface and foreground underline, never color alone.
- Charts use a 2px foreground line, subtle neutral grid, and a faint area fill.
- Report bars use the foreground color and preserve readable labels at 320px.
- Empty states explain what is missing and give the exact install snippet.

## Interaction and accessibility

- Use native links and buttons with 32–40px minimum control height.
- Preserve a visible 2px `:focus-visible` outline and logical DOM order.
- Include one `main`, one page `h1`, coherent section headings, and a skip link.
- Chart points expose their date and values in accessible labels. Annotation markers also have SVG titles and a readable notes list.
- Motion is limited to 150ms color/press feedback, only when reduced motion is
  not requested. Press scale is exactly `0.96`.
- Status never relies on color alone; the current visitor dot has text beside it.


Workspace sites use one compact table layout, including a single-site account.
Align numeric totals and reserve a defined column for smooth trend charts.
At narrow widths, stack each row without changing its table semantics.
Login and dashboard notifications use dismissible dark toasts outside the
main layout, so errors do not move forms or controls.
