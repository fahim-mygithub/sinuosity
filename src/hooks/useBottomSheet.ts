import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';

export type SheetState = 'peek' | 'half' | 'full';

/**
 * Visible sheet height at `peek`: the grab handle + the sheet's pinned action bar (context line +
 * primary action). Sized so the action bar is fully on screen at the SMALLEST snap point — the
 * point of pinning it is that it is reachable without expanding anything.
 */
const PEEK = 152;
/** `half` reveals this fraction of the viewport, so the map and the list share the screen. */
const HALF_FRACTION = 0.5;
const MOBILE_QUERY = '(max-width: 767px)';
const TAP_SLOP = 6; // px of movement below which a gesture counts as a tap, not a drag

/** Translate offsets (px down from fully open) for each snap point. `full` is always 0. */
export interface SnapOffsets {
  full: number;
  half: number;
  peek: number;
}

/**
 * Snap offsets for a sheet of `sheetH` px in a `viewportH` px viewport.
 *
 * The sheet is a FIXED height (see `--sheet-full`), not a content-derived one. That is what makes
 * these offsets stable: the old content-derived version silently changed the collapsed position
 * whenever a tab swapped in taller content, so the sheet could sit somewhere no snap point
 * described.
 */
export function snapOffsets(sheetH: number, viewportH: number): SnapOffsets {
  const peek = Math.max(0, sheetH - PEEK);
  // Clamped to `peek` so a short sheet in a tall viewport degrades to two distinct points rather
  // than putting `half` BELOW `peek` (which would make dragging up shrink the sheet).
  const half = Math.min(peek, Math.max(0, sheetH - Math.round(viewportH * HALF_FRACTION)));
  return { full: 0, half, peek };
}

/**
 * Pure snap decision used on pointer release. Extracted so it can be unit-tested directly.
 *  - A tap toggles open/closed. `half` is reachable by DRAGGING only: making a tap cycle
 *    peek → half → full would mean the handle no longer has a predictable result.
 *  - A drag commits to whichever snap point the LIVE offset is nearest.
 */
export function resolveSnap(opts: {
  cur: number;
  snaps: SnapOffsets;
  moved: number;
  state: SheetState;
  allowTap: boolean;
}): SheetState {
  const { cur, snaps, moved, state, allowTap } = opts;
  if (allowTap && moved < TAP_SLOP) return state === 'full' ? 'peek' : 'full';

  let best: SheetState = 'full';
  let bestDist = Infinity;
  for (const s of ['full', 'half', 'peek'] as const) {
    const d = Math.abs(cur - snaps[s]);
    if (d < bestDist) {
      bestDist = d;
      best = s;
    }
  }
  return best;
}

/**
 * Bottom-sheet / docked-panel controller.
 *
 * Mobile (<768px): a draggable bottom sheet with three snap points (peek / half / full).
 * Desktop (>=768px): a docked, always-open side panel — no drag, no transform.
 *
 * Design that keeps it stable:
 *  - `translate` is DERIVED, never separately stored: it is the live drag offset while dragging,
 *    otherwise it falls out of (snap state × measured offsets). Nothing can race to overwrite it.
 *  - The sheet's height is fixed in CSS, so the snap offsets do not move when tab content changes.
 *  - ONE Pointer Events path (mouse + touch + pen) with pointer capture.
 *  - The release decision reads the LIVE dragged offset from a ref, so a drag sticks where you
 *    leave it.
 *  - Offsets are measured before first paint (useLayoutEffect) and kept current by a
 *    ResizeObserver plus visualViewport resizes (mobile URL-bar show/hide).
 */
export function useBottomSheet() {
  const sheetRef = useRef<HTMLDivElement | null>(null);
  const [isMobile, setIsMobile] = useState(
    () => (typeof window !== 'undefined' ? window.matchMedia(MOBILE_QUERY).matches : true),
  );
  const [state, setState] = useState<SheetState>('peek');
  const [sheetH, setSheetH] = useState(0);
  const [snaps, setSnaps] = useState<SnapOffsets>({ full: 0, half: 0, peek: 0 });
  const [dragOffset, setDragOffset] = useState<number | null>(null);

  const drag = useRef({ active: false, startY: 0, startBase: 0, cur: 0, moved: 0, pid: -1, el: null as HTMLElement | null });

  // Measured snap offsets; kept current as the viewport changes (rotation, URL-bar show/hide).
  useLayoutEffect(() => {
    if (!isMobile) return;
    const el = sheetRef.current;
    if (!el) return;
    const measure = () => {
      const h = el.offsetHeight;
      setSheetH(h);
      setSnaps(snapOffsets(h, window.innerHeight));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    window.addEventListener('resize', measure);
    window.visualViewport?.addEventListener('resize', measure);
    return () => {
      ro.disconnect();
      window.removeEventListener('resize', measure);
      window.visualViewport?.removeEventListener('resize', measure);
    };
  }, [isMobile]);

  // Track viewport class. On desktop the panel is docked and fully open.
  useEffect(() => {
    const mq = window.matchMedia(MOBILE_QUERY);
    const onChange = () => setIsMobile(mq.matches);
    onChange();
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);

  // Single source of truth for the rendered offset.
  const translate = !isMobile ? 0 : dragOffset != null ? dragOffset : snaps[state];
  /** How much of the sheet is on screen right now — drives map fitBounds padding. */
  const visiblePx = isMobile ? Math.max(0, sheetH - translate) : 0;

  const onPointerDown = useCallback(
    (e: React.PointerEvent) => {
      if (!isMobile) return;
      const el = e.currentTarget as HTMLElement;
      const base = snaps[state];
      drag.current = { active: true, startY: e.clientY, startBase: base, cur: base, moved: 0, pid: e.pointerId, el };
      setDragOffset(base);
      try {
        el.setPointerCapture(e.pointerId);
      } catch {
        /* capture unsupported / synthetic pointer — events still reach the handle */
      }
    },
    [isMobile, state, snaps],
  );

  const onPointerMove = useCallback(
    (e: React.PointerEvent) => {
      if (!drag.current.active) return;
      const next = Math.min(snaps.peek, Math.max(0, drag.current.startBase + (e.clientY - drag.current.startY)));
      drag.current.cur = next;
      drag.current.moved = Math.max(drag.current.moved, Math.abs(e.clientY - drag.current.startY));
      setDragOffset(next);
    },
    [snaps.peek],
  );

  const finish = useCallback(
    (allowTap: boolean) => {
      if (!drag.current.active) return;
      const { cur, moved, el, pid } = drag.current;
      drag.current.active = false;
      drag.current.el = null;
      if (el && pid >= 0) {
        try {
          el.releasePointerCapture(pid);
        } catch {
          /* already released on pointerup */
        }
      }
      setState(resolveSnap({ cur, snaps, moved, state, allowTap }));
      setDragOffset(null);
    },
    [snaps, state],
  );

  const onPointerUp = useCallback(() => finish(true), [finish]);
  const onPointerCancel = useCallback(() => finish(false), [finish]);

  const snapTo = useCallback(
    (s: SheetState) => {
      if (isMobile) setState(s);
    },
    [isMobile],
  );
  const toggle = useCallback(() => setState((s) => (s === 'full' ? 'peek' : 'full')), []);
  const expand = useCallback(() => {
    if (isMobile) setState('full');
  }, [isMobile]);
  const collapse = useCallback(() => {
    if (isMobile) setState('peek');
  }, [isMobile]);

  return {
    sheetRef,
    isMobile,
    translate,
    visiblePx,
    state,
    dragging: dragOffset != null,
    snapTo,
    toggle,
    expand,
    collapse,
    onPointerDown,
    onPointerMove,
    onPointerUp,
    onPointerCancel,
  };
}
