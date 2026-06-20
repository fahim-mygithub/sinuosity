# Sinuosity — UX / UI Analysis

_Date: 2026-06-19 · Scope: usability audit of the whole app, with a deep dive on the
"pull-up menu" (bottom sheet) that the user reports as **weird and not stable**._

Method: read of all UI code (`App.tsx`, `useBottomSheet.ts`, `useLeafletMap.ts`,
`ScenicRoutePreview.tsx`, `RouteDetail.tsx`, `index.css`, `index.html`) plus live
inspection of the running app in Chrome (DOM, computed styles, console).

---

## TL;DR

The bottom sheet is the right _idea_ but its drag engine is built on three fragile
foundations, each independently enough to make it feel broken:

1. **Mouse drag never sticks** — it springs back to where it started (stale React
   closure in the document `mouseup` listener).
2. **Inner lists can't be scrolled by finger** — `touch-action: none` is on the whole
   sheet instead of just the grab handle, so on a phone the main content is unreachable.
3. **Tap and drag fight each other** — the handle wires up `onClick` _and_ a manual drag,
   so most gestures fire two competing state updates ("jumpiness").

On top of that the sheet has no responsive behavior: on a desktop (tested at 3822px wide)
it is a narrow phone strip floating at the bottom-center, and a drag handle makes no sense
with a mouse. Fixing the sheet is ~80% of the perceived-stability win; making it responsive
(docked panel on desktop, stable sheet on mobile) removes the "weird" feeling entirely.

---

## Severity-ranked findings

### The pull-up menu (headline complaint)

#### S1 · Critical — Mouse drag springs back; the drag never changes state
`useBottomSheet.onPointerUp` decides the snap target from the `translate` value, but the
document `mouseup` handler (`mu`) is created inside `onMouseDown` and closes over the
`sheet` object **from the render at mousedown time**. React state captured in that closure
(`translate`) is frozen at its mousedown value, so on release the snap decision is always
`translate(at-mousedown) > maxTranslate*0.4`, i.e. it resolves back to the state the drag
_started_ in — regardless of how far you dragged.

Effect: the sheet visibly follows the cursor while you drag, then snaps back on release.
You cannot drag-expand or drag-collapse with a mouse at all.

Files: `src/hooks/useBottomSheet.ts:41-45`, `src/App.tsx:236-242`.

#### S2 · Critical — Inner content can't scroll on touch devices
`index.css:24` sets `.sheet { touch-action: none }` on the **entire** sheet. `touch-action`
gates touch panning for the touched element _and its descendants up to the scroll
container_, so the inner `overflow-y-auto` lists (scenic list, curated list, route preview,
scan results) cannot be scrolled with a finger. Confirmed live: the sheet computes
`touch-action: none` while the inner scroller computes `auto`, but the ancestor wins on
touch. On a phone — the primary target — most of the app's content is unreachable.

Files: `src/index.css:24`.

#### S3 · High — Tap and drag are wired to the same element and conflict
The handle has `onClick={sheet.toggle}` _and_ `onTouchStart/Move/End` + `onMouseDown` drag
handlers. Any release the browser also treats as a click runs `onPointerUp` (a snap) **and**
`toggle` (a flip) — two state updates per gesture. Even a clean click first runs a spurious
`snapTo(...)` (using the stale value from S1) before toggling. This double code-path is the
visible "jumpiness / not stable."

Files: `src/App.tsx:230-245`.

#### S4 · High — Peek height goes stale when content changes
`maxTranslate()` reads `offsetHeight` only at snap time and there is no `ResizeObserver`.
When the sheet's content height changes — switching tabs, selecting a route that mounts the
image-heavy `ScenicRoutePreview`, scan results arriving — the collapsed (peek) offset is
computed from an old height. The collapsed sheet then either floats above the bottom edge
or clips its own content until the next snap.

Files: `src/hooks/useBottomSheet.ts:17-25`.

#### S5 · Medium — Mount flash
`translate` initializes to `9999` and is corrected on the next animation frame, so the sheet
can flash in from far off-screen on first paint.

Files: `src/hooks/useBottomSheet.ts:12,28-31`.

#### S6 · Medium — Sheet has no keyboard or screen-reader support
The handle is a bare `<div>` (no `role`, `tabIndex`, `aria-expanded`, or key handler).
Keyboard and assistive-tech users cannot open or close the sheet. There is no focus
management when it opens.

Files: `src/App.tsx:230-245`.

#### S7 · Medium — `expand()` overrides user intent on every tab switch / selection
`switchTab`, `selectScenic`, `selectCurated`, `selectScan` all force the sheet to full.
Switching tabs always slams it open, discarding wherever the user left it; combined with S1
the state feels arbitrary.

Files: `src/App.tsx:94,111,124,175`.

### Broader usability

#### S8 · High — No responsive layout (desktop is a phone UI stretched over a wall)
Every surface is a mobile bottom-sheet centered at `max-w-2xl`. On a wide desktop the sheet
is a narrow strip floating bottom-center over an enormous map, and the drag affordance is
meaningless with a mouse. A docked side panel on `md+` viewports (no drag) would be far more
stable and is the natural desktop pattern.

#### S9 · Medium — Status toast permanently occupies space and overlaps the map
The status bar is fixed at `top-24`, `z-1200` (above the sheet), never auto-dismisses, and
always covers a band of the map.

Files: `src/App.tsx:207-210`.

#### S10 · Medium — Expanded sheet hides the map with no scrim or tap-to-dismiss
At full height (80vh) the sheet covers most of the map; there is no backdrop to signal
modality and tapping the map doesn't collapse it. The list↔map relationship is unclear.

#### S11 · Low — `fitBounds` ignores the sheet, drawing routes underneath it
Route selection expands the sheet over the bottom of the map but `fitBounds` uses symmetric
`[70,70]` padding, so the selected route can render hidden behind the sheet.

Files: `src/App.tsx:85,105,117`.

#### S12 · Low — Sub-minimum tap targets and very dense 9–11px text
Numerous controls (back links, reset, "Open in Street View", rubric labels) use 9–11px text
and thin underline hit areas below the ~44px touch-target guideline.

#### S13 · Low — Flat hierarchy and unexplained jargon
Scenic / Curated / Scan read as equal peers though Scenic is the flagship; "Scan" surfaces
raw OSM terms ("curve density") with no onboarding.

---

## Recommended fix (what this change implements)

**Rebuild the sheet as one stable, responsive panel** instead of patching the drag math:

- **One pointer code-path** using the Pointer Events API with `setPointerCapture` — mouse,
  touch, and pen share a single handler; no more `document` listeners created per gesture,
  no `onClick`+drag conflict (S1, S3).
- **Snap decision from the live dragged value**, tracked in a ref and read at release —
  removes the stale-closure spring-back (S1).
- **`touch-action` scoped correctly**: `none` only on the handle; inner scrollers get
  `pan-y` + `overscroll-contain` so finger scrolling works and doesn't chain to the page
  (S2).
- **`ResizeObserver`** keeps the peek offset correct as content height changes (S4); no
  more mount flash because the initial position is derived from a measured height (S5).
- **Real toggle affordance**: the handle becomes a `<button>` with `aria-expanded`, keyboard
  toggle, and `Esc` to collapse; focus is managed on open (S6).
- **Responsive**: on `md+` the panel docks as a fixed left sidebar (no drag, always
  visible); on mobile it stays a bottom sheet (S8). The map `fitBounds`/padding accounts for
  the occupied area so routes are never hidden (S11).
- **Scrim on mobile when expanded**, tap-to-collapse (S10); the status toast auto-dismisses
  and yields space (S9).

These are sequenced so the three critical/high sheet bugs (S1–S4) are resolved by the core
rewrite; S8–S13 are addressed by the responsive shell around it.
