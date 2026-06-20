import { describe, it, expect } from 'vitest';
import { resolveSnap } from './useBottomSheet';

// maxT (the collapsed offset) of 300 means: 0 = fully open, 300 = peek.
const MAX = 300;

describe('resolveSnap — pointer-release snap decision', () => {
  it('a tap from peek opens (toggles to full)', () => {
    expect(resolveSnap({ cur: MAX, maxT: MAX, moved: 2, state: 'peek', allowTap: true })).toBe('full');
  });

  it('a tap from full closes (toggles to peek)', () => {
    expect(resolveSnap({ cur: 0, maxT: MAX, moved: 1, state: 'full', allowTap: true })).toBe('peek');
  });

  it('a drag up past the midpoint sticks open — this is the bug that used to spring back', () => {
    // released near the top (small offset) => full, regardless of where it started
    expect(resolveSnap({ cur: 80, maxT: MAX, moved: 220, state: 'peek', allowTap: true })).toBe('full');
  });

  it('a drag down past the midpoint snaps to peek', () => {
    expect(resolveSnap({ cur: 260, maxT: MAX, moved: 200, state: 'full', allowTap: true })).toBe('peek');
  });

  it('a long drag never counts as a tap even with allowTap', () => {
    // moved is large, so the tap branch is skipped and it snaps by position (open)
    expect(resolveSnap({ cur: 10, maxT: MAX, moved: 500, state: 'peek', allowTap: true })).toBe('full');
  });

  it('pointer-cancel (allowTap=false) snaps by position, never toggles', () => {
    // tiny movement but allowTap false => decide by position; near peek => peek
    expect(resolveSnap({ cur: MAX, maxT: MAX, moved: 1, state: 'full', allowTap: false })).toBe('peek');
  });

  it('exactly at the midpoint resolves to full (not strictly greater)', () => {
    expect(resolveSnap({ cur: MAX / 2, maxT: MAX, moved: 100, state: 'peek', allowTap: true })).toBe('full');
  });
});
