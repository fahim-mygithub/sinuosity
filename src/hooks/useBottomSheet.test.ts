import { describe, it, expect } from 'vitest';
import { resolveSnap, snapOffsets, type SnapOffsets } from './useBottomSheet';

// A 780px sheet in an 844px viewport: 0 = fully open, 390 = half, 648 = peek.
const SNAPS: SnapOffsets = snapOffsets(780, 844);

describe('snapOffsets', () => {
  it('orders the snap points full <= half <= peek', () => {
    expect(SNAPS.full).toBe(0);
    expect(SNAPS.half).toBeGreaterThan(SNAPS.full);
    expect(SNAPS.peek).toBeGreaterThan(SNAPS.half);
  });

  it('leaves exactly the peek height visible at the peek offset', () => {
    expect(780 - SNAPS.peek).toBe(152);
  });

  it('leaves about half the viewport visible at the half offset', () => {
    expect(780 - SNAPS.half).toBe(422); // round(844 * 0.5)
  });

  it('never puts half BELOW peek when the sheet is short relative to the viewport', () => {
    // A 300px sheet in an 844px viewport: half would want 300-422 < 0, and an unclamped peek
    // would sit above it — dragging up would then SHRINK the sheet.
    const s = snapOffsets(300, 844);
    expect(s.half).toBeLessThanOrEqual(s.peek);
    expect(s.half).toBeGreaterThanOrEqual(0);
  });

  it('clamps to zero rather than going negative for a sheet shorter than the peek height', () => {
    const s = snapOffsets(90, 844);
    expect(s.peek).toBe(0);
    expect(s.half).toBe(0);
  });
});

describe('resolveSnap — pointer-release snap decision', () => {
  it('a tap from peek opens (toggles to full)', () => {
    expect(resolveSnap({ cur: SNAPS.peek, snaps: SNAPS, moved: 2, state: 'peek', allowTap: true })).toBe('full');
  });

  it('a tap from full closes (toggles to peek)', () => {
    expect(resolveSnap({ cur: 0, snaps: SNAPS, moved: 1, state: 'full', allowTap: true })).toBe('peek');
  });

  it('a tap from half opens rather than cycling', () => {
    // `half` is drag-only on purpose: a tap that cycled peek → half → full would make the
    // handle's result depend on invisible state.
    expect(resolveSnap({ cur: SNAPS.half, snaps: SNAPS, moved: 3, state: 'half', allowTap: true })).toBe('full');
  });

  it('a drag up near the top sticks open — this is the bug that used to spring back', () => {
    expect(resolveSnap({ cur: 40, snaps: SNAPS, moved: 400, state: 'peek', allowTap: true })).toBe('full');
  });

  it('a drag released near the half offset snaps to half', () => {
    expect(resolveSnap({ cur: SNAPS.half + 20, snaps: SNAPS, moved: 200, state: 'peek', allowTap: true })).toBe('half');
    expect(resolveSnap({ cur: SNAPS.half - 20, snaps: SNAPS, moved: 200, state: 'full', allowTap: true })).toBe('half');
  });

  it('a drag down near the bottom snaps to peek', () => {
    expect(resolveSnap({ cur: SNAPS.peek - 10, snaps: SNAPS, moved: 300, state: 'full', allowTap: true })).toBe('peek');
  });

  it('a long drag never counts as a tap even with allowTap', () => {
    expect(resolveSnap({ cur: 10, snaps: SNAPS, moved: 500, state: 'peek', allowTap: true })).toBe('full');
  });

  it('pointer-cancel (allowTap=false) snaps by position, never toggles', () => {
    expect(resolveSnap({ cur: SNAPS.peek, snaps: SNAPS, moved: 1, state: 'full', allowTap: false })).toBe('peek');
  });

  it('picks the NEAREST snap, not the first one it passes', () => {
    // Just above the midpoint between half and peek => still half.
    const mid = (SNAPS.half + SNAPS.peek) / 2;
    expect(resolveSnap({ cur: mid - 1, snaps: SNAPS, moved: 200, state: 'peek', allowTap: true })).toBe('half');
    expect(resolveSnap({ cur: mid + 1, snaps: SNAPS, moved: 200, state: 'peek', allowTap: true })).toBe('peek');
  });

  it('degenerate offsets (all equal) resolve without throwing', () => {
    const flat: SnapOffsets = { full: 0, half: 0, peek: 0 };
    expect(resolveSnap({ cur: 0, snaps: flat, moved: 100, state: 'peek', allowTap: true })).toBe('full');
  });
});
