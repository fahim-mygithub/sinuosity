import { useCallback, useEffect, useRef, useState } from 'react';

type SheetState = 'peek' | 'full';
const PEEK = 168;

/**
 * Bottom-sheet drag logic. Tracks the vertical offset in React state — never
 * parses getComputedStyle/DOMMatrix (the source of the original "Script error").
 */
export function useBottomSheet() {
  const sheetRef = useRef<HTMLDivElement | null>(null);
  const [translate, setTranslate] = useState(9999); // start collapsed; corrected on mount
  const [state, setState] = useState<SheetState>('peek');

  const drag = useRef({ startY: 0, startT: 0, active: false });

  const maxTranslate = useCallback(() => {
    const h = sheetRef.current?.offsetHeight ?? 0;
    return Math.max(0, h - PEEK);
  }, []);

  const snapTo = useCallback((s: SheetState) => {
    setState(s);
    setTranslate(s === 'full' ? 0 : maxTranslate());
  }, [maxTranslate]);

  // Set correct peek position once the sheet has a measured height.
  useEffect(() => {
    const id = requestAnimationFrame(() => snapTo('peek'));
    return () => cancelAnimationFrame(id);
  }, [snapTo]);

  const onPointerDown = (clientY: number) => {
    drag.current = { startY: clientY, startT: translate, active: true };
  };
  const onPointerMove = (clientY: number) => {
    if (!drag.current.active) return;
    const next = Math.min(maxTranslate(), Math.max(0, drag.current.startT + (clientY - drag.current.startY)));
    setTranslate(next);
  };
  const onPointerUp = () => {
    if (!drag.current.active) return;
    drag.current.active = false;
    snapTo(translate > maxTranslate() * 0.4 ? 'peek' : 'full');
  };

  const toggle = () => snapTo(state === 'peek' ? 'full' : 'peek');

  return { sheetRef, translate, state, snapTo, toggle, onPointerDown, onPointerMove, onPointerUp, expand: () => snapTo('full') };
}
