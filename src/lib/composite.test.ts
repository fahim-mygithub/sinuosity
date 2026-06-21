import { describe, it, expect } from 'vitest'
import type { ScenicRubric } from '../data/types'
import {
  COMPOSITE_WEIGHTS,
  BIAS_PRESETS,
  compositeScore,
  normalizeWeights,
  type BiasWeights,
} from './composite'

const sum = (w: BiasWeights) =>
  w.curvature + w.scenery + w.greenery + w.water + w.notability

describe('compositeScore', () => {
  it('matches Math.round(weightedAvg * 10) with the default weights', () => {
    const rubric: ScenicRubric = { curvature: 8, scenery: 6, greenery: 7, water: 4, notability: 5 }
    const w = COMPOSITE_WEIGHTS
    const avg =
      w.curvature * rubric.curvature +
      w.scenery * rubric.scenery +
      w.greenery * rubric.greenery +
      w.water * rubric.water +
      w.notability * rubric.notability
    expect(compositeScore(rubric)).toBe(Math.round(avg * 10))
  })

  it('treats a perfect 10 rubric as 100 under default weights', () => {
    const rubric: ScenicRubric = { curvature: 10, scenery: 10, greenery: 10, water: 10, notability: 10 }
    expect(compositeScore(rubric)).toBe(100)
  })

  it('treats missing rubric fields as 0', () => {
    const rubric = { curvature: 10 } as unknown as ScenicRubric
    // curvature 10 * 0.35 weight = 3.5 -> *10 = 35
    expect(compositeScore(rubric)).toBe(35)
  })
})

describe('normalizeWeights', () => {
  it('produces weights that sum to ~1', () => {
    const out = normalizeWeights({ curvature: 2, scenery: 1, greenery: 1, water: 1, notability: 5 })
    expect(Math.abs(sum(out) - 1)).toBeLessThan(1e-9)
  })

  it('returns COMPOSITE_WEIGHTS for an all-zero set', () => {
    expect(normalizeWeights({ curvature: 0, scenery: 0, greenery: 0, water: 0, notability: 0 })).toEqual(
      COMPOSITE_WEIGHTS,
    )
  })

  it('clamps negatives to 0, and falls back to default if all are non-positive', () => {
    const out = normalizeWeights({ curvature: -1, scenery: 3, greenery: 0, water: 1, notability: 0 })
    expect(Math.abs(sum(out) - 1)).toBeLessThan(1e-9)
    expect(out.curvature).toBe(0)
    expect(normalizeWeights({ curvature: -1, scenery: -2, greenery: 0, water: 0, notability: 0 })).toEqual(
      COMPOSITE_WEIGHTS,
    )
  })
})

describe('bias affects ranking', () => {
  it('scores a twisty road higher under a twisty bias than under balanced', () => {
    const twistyRoad: ScenicRubric = { curvature: 10, scenery: 2, greenery: 2, water: 1, notability: 1 }
    const twistyBias: BiasWeights = { curvature: 0.6, scenery: 0.1, greenery: 0.1, water: 0.1, notability: 0.1 }
    expect(compositeScore(twistyRoad, twistyBias)).toBeGreaterThan(compositeScore(twistyRoad, COMPOSITE_WEIGHTS))
  })
})

describe('BIAS_PRESETS', () => {
  it('includes the expected presets with the balanced default', () => {
    const ids = BIAS_PRESETS.map((p) => p.id)
    expect(ids).toEqual(expect.arrayContaining(['balanced', 'twisty', 'scenic', 'waterside', 'notable']))
    expect(BIAS_PRESETS.find((p) => p.id === 'balanced')!.weights).toEqual(COMPOSITE_WEIGHTS)
  })

  it('every preset has 5 finite weights and a non-empty hint', () => {
    for (const p of BIAS_PRESETS) {
      const vals = [p.weights.curvature, p.weights.scenery, p.weights.greenery, p.weights.water, p.weights.notability]
      expect(vals).toHaveLength(5)
      for (const v of vals) expect(Number.isFinite(v)).toBe(true)
      expect(p.hint.length).toBeGreaterThan(0)
    }
  })
})
