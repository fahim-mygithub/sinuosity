import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';

export type SheetState = 'peek' | 'full';
const PEEK = 168;
const MOBILE_QUERY = '(max-width: 767px)';
const TAP_SLOP = 6; // px of movement below which a gesture counts as a tap, not a drag

/**
 * Pure snap decision used on pointer release. Extracted so it can be unit-tested directly —
 * this is exactly the logic whose old (stale-closure) version made the sheet spring back.
 *  - A tap (negligible movement) toggles the current state.
 *  - A drag commits to whichever snap point the LIVE offset is closer to.
 */
export function resolveSnap(opts: {
  cur: number;
  maxT: number;
  moved: number;
  state: SheetState;
  allowTap: boolean;
}): SheetState {
  const { cur, maxT, moved, state, allowTap } = opts;
  if (allowTap && moved < TAP_SLOP) return state === 'full' ? 'peek' : 'full';
  return cur > maxT * 0.5 ? 'peek' : 'full';
}

/**
 * Bottom-sheet / docked-panel controller.
 *
 * Mobile (<768px): a draggable bottom sheet with two snap points (peek / full).
 * Desktop (>=768px): a docked, always-open side panel — no drag, no transform.
 *
 * Design that keeps it stable (these were the failure modes of the old version):
 *  - `translate` is DERIVED, never separately stored: it is the live drag offset while
 *    dragging, otherwise it falls out of (snap state × measured max). Nothing can race to
 *    overwrite it, and the collapsed position auto-tracks content-height changes.
 *  - ONE Pointer Events path (mouse + touch + pen) with pointer capture — no separate
 *    onClick fighting the drag, no per-gesture document listeners, no stale closures.
 *  - The release decision reads the LIVE dragged offset from a ref, so a drag actually
 *    sticks where you leave it.
 *  - `maxT` is measured before first paint (useLayoutEffect) and kept current by a
 *    ResizeObserver, so there is no mount flash and the peek height is always honest.
 */
export function useBottomSheet() {
  const sheetRef = useRef<HTMLDivElement | null>(null);
  const [isMobile, setIsMobile] = useState(
    () => (typeof window !== 'undefined' ? window.matchMedia(MOBILE_QUERY).matches : true),
  );
  const [state, setState] = useState<SheetState>('peek');
  const [maxT, setMaxT] = useState(0);
  const [dragOffset, setDragOffset] = useState<number | null>(null);

  const drag = useRef({ active: false, startY: 0, startBase: 0, cur: 0, moved: 0, pid: -1, el: null as HTMLElement | null });

  // Measured collapsed offset; kept current as content height changes.
  useLayoutEffect(() => {
    if (!isMobile) return;
    const el = sheetRef.current;
    if (!el) return;
    const measure = () => setMaxT(Math.max(0, el.offsetHeight - PEEK));
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
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
  const translate = !isMobile ? 0 : dragOffset != null ? dragOffset : state === 'full' ? 0 : maxT;

  const onPointerDown = useCallback(
    (e: React.PointerEvent) => {
      if (!isMobile) return;
      const el = e.currentTarget as HTMLElement;
      const base = state === 'full' ? 0 : maxT;
      drag.current = { active: true, startY: e.clientY, startBase: base, cur: base, moved: 0, pid: e.pointerId, el };
      setDragOffset(base);
      try {
        el.setPointerCapture(e.pointerId);
      } catch {
        /* capture unsupported / synthetic pointer — events still reach the handle */
      }
    },
    [isMobile, state, maxT],
  );

  const onPointerMove = useCallback(
    (e: React.PointerEvent) => {
      if (!drag.current.active) return;
      const next = Math.min(maxT, Math.max(0, drag.current.startBase + (e.clientY - drag.current.startY)));
      drag.current.cur = next;
      drag.current.moved = Math.max(drag.current.moved, Math.abs(e.clientY - drag.current.startY));
      setDragOffset(next);
    },
    [maxT],
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
      const target = resolveSnap({ cur, maxT, moved, state, allowTap });
      setState(target);
      setDragOffset(null);
    },
    [maxT, state],
  );

  const onPointerUp = useCallback(() => finish(true), [finish]);
  const onPointerCancel = useCallback(() => finish(false), [finish]);

  const snapTo = useCallback((s: SheetState) => setState(s), []);
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
