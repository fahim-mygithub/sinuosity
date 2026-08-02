import { useState } from 'react';
import { hasGoogleKey, streetViewDeepLink, streetViewStaticUrl } from '../lib/scenicImagery';
import type { Units } from '../lib/preferences';
import { FULL_JUNCTION_DENSITY, FULL_JUNCTION_PER_KM } from '../lib/reelTypes';
import type { CleanReading, LateralFall, ReelMark, ReelMetrics, Side } from '../lib/reelTypes';

/**
 * One filmable stretch of road, written out for the rider: which way to ride it, when to be there,
 * what is behind them when they get there, and a Street View frame aimed at that backdrop.
 *
 * MAP DATA RANKS; IMAGERY CONFIRMS. That split is the reason the Street View frame is the largest
 * thing on the card. The ground truth under every score here is 32 good/bad calls on rendered shots
 * from ONE 28-minute suburban ride, one evening, one rider — and where the same mark was judged
 * twice the two verdicts disagreed often enough to put kappa at 0.53 (see reelTypes.ts). A per-mark
 * predictor is bounded at roughly 78% agreement with a human who does not agree with themselves, so
 * nothing on this card may show a confidence, a "match %", or a decimal the data cannot carry.
 * Showing the rider the actual verge beats any inference this app can make about it.
 */

/** Metres to feet, as in ElevationProfile — one conversion, one constant, one register. */
const M_TO_FT = 3.28084;

/**
 * The quantum every measured distance on this card is rendered at (m). NOT house style — a claim
 * about what the two quantities behind it can actually resolve.
 *
 * `LateralFall.fallM` comes from Copernicus GLO-90 as served by Open-Meteo: a measured ~69 m cell at
 * 42°N, a few metres of vertical error of its own, and — worse, and one-signed — a measured 3.6x
 * underestimate of the horizon angle at Zoar Valley, i.e. it smooths exactly the narrow gorges this
 * feature exists to find. Painting that to the foot ("427 ft") claims a survey of a number whose
 * documented bias is larger than most of the values it takes.
 *
 * `BackdropReading.waterM` is the distance from the nearest of the window's 25 m-spaced samples to
 * the nearest open-water TELL, and a tell is a downsampled polygon vertex quantised at 1e-5 deg in
 * the tiles. It is "how far off is the lake", not a survey of a shoreline that was never traced.
 *
 * 10 m is coarse enough to make no claim either can't carry and fine enough to keep the distinction
 * the reading is for — water at 80 m fills a 9:16 frame and the same lake at 340 m is a smudge (the
 * measured spread inside `BACKDROP_WATER_M` is p25 = 84 m, p50 = 154 m, p75 = 252 m). The placement
 * inside that range is a judgement call; the two bounds are measured.
 */
const COARSE_M = 10;

/**
 * A measured distance in the rider's units, at {@link COARSE_M}.
 *
 * Rounds in METRES and converts the rounded value, so the imperial column is never finer than the
 * metric one — converting first and rounding to the foot is exactly the false precision this
 * replaces. Anything under half a quantum reads "under N", because "0 m of fall" on a line that only
 * renders when the fall is positive is a contradiction rather than a measurement.
 */
export function coarseLength(m: number, units: Units): string {
  const q = Math.round(m / COARSE_M) * COARSE_M;
  const ft = (n: number) => Math.round((n * M_TO_FT) / 10) * 10;
  if (q === 0) return units === 'mi' ? `under ${ft(COARSE_M)} ft` : `under ${COARSE_M} m`;
  return units === 'mi' ? `${ft(q)} ft` : `${q} m`;
}

/**
 * The four scored dimensions in display order, shared with the panel's weight sliders so a metric
 * cannot be labelled one thing on the card and another on the slider that moves it. Order follows
 * `REEL_WEIGHTS`, heaviest first, so the list reads as what the category is about.
 */
export const REEL_METRIC_ROWS: { key: keyof ReelMetrics; label: string; hint: string }[] = [
  { key: 'backdrop', label: 'Backdrop', hint: 'Ground falling away, or open water, to one side' },
  { key: 'cleanliness', label: 'Clean', hint: 'Away from suburbia — side streets, driveways, sheds' },
  { key: 'light', label: 'Light', hint: 'How high the sun is, times how it sits for this camera' },
  { key: 'drama', label: 'Corners', hint: 'Total heading change through the 400 m stretch' },
];

const COMPASS = [
  'north', 'north-east', 'east', 'south-east',
  'south', 'south-west', 'west', 'north-west',
] as const;

/** Fold any bearing into [0, 360). Handles the negative results of `travel - 90` below. */
export function normalizeBearing(deg: number): number {
  return ((deg % 360) + 360) % 360;
}

/** Nearest of the 8 compass points, spelled out. 45 deg per point, so the rounding is exact. */
export function compassName(bearingDeg: number): string {
  return COMPASS[Math.round(normalizeBearing(bearingDeg) / 45) % 8];
}

/**
 * The human form of a direction of travel: "west to east" for a bearing of 90.
 *
 * A rider does not think in bearings, they think in ends of a road, and WHICH DIRECTION is half of
 * everything this category outputs — so the phrase names the end started FROM as well as the end
 * ridden TOWARDS. The origin is the antipode of the heading by construction rather than by a
 * lookup table, so the two halves cannot drift apart.
 */
export function rideDirectionPhrase(bearingDeg: number): string {
  return `${compassName(bearingDeg + 180)} to ${compassName(bearingDeg)}`;
}

/**
 * Street View heading that looks at the backdrop: perpendicular to travel, on the backdrop's side.
 *
 * Face north (bearing 0) and your right hand points east (bearing 90), so the right side of a rider
 * is travel + 90 and the left is travel - 90. A sign error here would aim the confirmation frame at
 * the opposite verge and quietly confirm the wrong thing — which is the single failure this whole
 * card exists to prevent, so it is spelled out rather than inlined.
 *
 * A `null` side means neither verge cleared `BACKDROP_MIN`. It aims right anyway, because right is
 * the boom the rig actually carries: with nothing scored on either side, the useful question is
 * still "what will the mounted camera see".
 *
 * THE `left` BRANCH IS KEPT ALTHOUGH NO EMITTED MARK CARRIES `left` (see the invariant on
 * {@link ShootCard} below). This is a general geometric utility over a genuinely two-sided quantity
 * — `PerSide` readings really do exist on both verges, and a caller asking "what is across the road"
 * is asking a question with a correct answer. It is the SELECTED side of a mark that is invariably
 * right, not the sign convention.
 */
export function backdropHeading(travelBearingDeg: number, side: Side | null): number {
  return normalizeBearing(travelBearingDeg + (side === 'left' ? -90 : 90));
}

/**
 * How the DEM half of `backdrop` stands for this mark. THREE states, not two.
 *
 * `LateralFall` arrives asynchronously and `null` is ambiguous on its own: `enrichMarks` re-scores
 * with `fall = null` both while the lookup is outstanding and after it has permanently failed, and
 * a mark carries nothing that separates them. So the card used to say "ground relief not read YET"
 * forever after a dead DEM — a promise it could not keep, over the dimension carrying 0.40 of the
 * composite. The missing bit is the caller's `refining` flag, which is honest about exactly this:
 * true while `enrichMarks` is in flight, false once it has settled either way.
 *
 * WHAT THIS STILL CANNOT SEE, stated rather than guessed at: it cannot separate a network failure
 * from a 429 from an empty answer, because `fetchLateralFall` collapses all of them to a null map.
 * `unavailable` therefore claims only "we did not get a reading", which is what the rider needs and
 * all the data supports. It also assumes the mark is inside the probe budget, which every mark in a
 * shortlist is — `DEFAULT_MARK_LIMIT` is defined as `MAX_PROBE_WINDOWS` for that reason.
 */
export type TerrainRead = 'read' | 'reading' | 'unavailable';

export function terrainRead(fall: LateralFall | null, refining: boolean): TerrainRead {
  if (fall) return 'read';
  return refining ? 'reading' : 'unavailable';
}

/** The relief clause on the backdrop line, or null when there is a real reading to show instead. */
export function terrainClause(state: TerrainRead): string | null {
  if (state === 'read') return null;
  return state === 'reading'
    ? 'ground relief still being read'
    : 'ground relief could not be read — this is water only';
}

/**
 * What to say when neither verge cleared `BACKDROP_MIN`.
 *
 * "Nothing here reads as an open view" is only true if we looked. With the DEM missing, backdrop
 * was decided on open water alone, and a gorge road with no lake beside it fails that test while
 * being exactly the road this feature exists to find.
 */
export function noBackdropPhrase(state: TerrainRead): string {
  switch (state) {
    case 'reading':
      return 'neither side clears the bar yet — the ground-relief reading is still coming in';
    case 'unavailable':
      return (
        'neither side cleared the bar on open water alone — the ground-relief lookup did not land, ' +
        'so half of the backdrop test is missing here'
      );
    default:
      return 'neither side cleared the bar — nothing here reads as an open view';
  }
}

/**
 * `LateralFall.atM` is one of exactly four probe distances and means THE SCALE OF THE LANDFORM, not
 * a measured distance to anything. Rendering 1500 m as "4921 ft" claims a survey of a quantity that
 * only ever takes four values, on a DEM whose measured cell is ~69 m.
 *
 * The imperial column is not a conversion, it is the nearest thing a rider says out loud — and two
 * of the four land on it exactly: a quarter mile is 402 m and a half mile is 804 m. 200 m is 219
 * yards, and 1500 m is 0.93 of a mile, so both are named approximately and the word "about" carries
 * the rest. Returns null for any value outside the set, including the `atM = 0` sentinel that
 * `readFall` uses for "no distance produced a fall", so a caller cannot render a scale that was
 * never measured.
 */
const LANDFORM_SCALE: Record<number, { m: string; mi: string }> = {
  200: { m: '200 m', mi: '200 yards' },
  400: { m: '400 m', mi: 'a quarter mile' },
  800: { m: '800 m', mi: 'half a mile' },
  1500: { m: '1.5 km', mi: 'a mile' },
};

export function landformScaleLabel(atM: number, units: Units): string | null {
  const entry = LANDFORM_SCALE[atM];
  if (!entry) return null;
  return `about ${units === 'mi' ? entry.mi : entry.m}`;
}

/**
 * Both free cleanliness proxies land on a 0.5 quantum, so 0.5 is what they are printed at.
 *
 * `junctionsPerKm` counts junctions over a FIXED 400 m window, i.e. 2.5/km per physical junction;
 * measured over the real corpus's 1,417 windows it takes 25 distinct values, 73.9% of them zero.
 * `junctionDensity` counts nodes over a FIXED 800 m disc, i.e. 1/(pi * 0.8²) = 0.50 nodes/km² per
 * node. A tenth of a unit on either is finer than one whole junction, so `toFixed(1)` was painting
 * resolution that neither reading has — and it painted "0.0" as the stated reason for a mid-range
 * cleanliness, which is where it showed.
 */
export function proxyValue(n: number): string {
  return String(Math.round(n * 2) / 2);
}

/**
 * Which term actually held a provisional cleanliness score down. FOUR answers, not two.
 *
 * `scoreClean` takes the WORSE of two normalised free readings — junctions per km ALONG the window
 * against `FULL_JUNCTION_PER_KM`, and corpus way-endpoint nodes per km² AROUND it against
 * `FULL_JUNCTION_DENSITY` — and then scales the result down by `uglyFrac`. The card used to name the
 * first of those unconditionally. Measured over all 1,417 windows of the real corpus the BINDING
 * term is `junctionDensity` 74.6% of the time against `junctionsPerKm` 9.2% (on a top-40 shortlist,
 * 24 against 3), so on a typical shortlist mark the card printed "0.0 junctions per km" as the
 * stated reason for a cleanliness of 5 or 7 — a flat contradiction in the rider's own words.
 *
 * `CleanReading` needs no new field to answer this: it already carries both readings, and dividing
 * by the same two constants `scoreClean` divides by recovers the binding term exactly rather than
 * guessing at it.
 *
 * `ugly` is the third answer and is deliberately not lumped in with the other two — `uglyFrac` scales
 * the score MULTIPLICATIVELY after the penalty, so a window that nothing tees into, in country with
 * nothing around it, can still read 7 purely because a third of it sits inside a quarry. Naming a
 * junction term there would be the same contradiction one term over. `none` is the honest fourth.
 *
 * THE TIE GOES TO `junctionDensity`, and that is a judgement call rather than a measurement. The two
 * normalised readings are equal only when both are zero, and then neither is "the" reason — but
 * density is the continuous half of the pair and the half that binds eight times more often, so it
 * is the one worth naming when the pair is what a rider is being told about.
 */
export type CleanDriver = 'junctionsPerKm' | 'junctionDensity' | 'ugly' | 'none';

export function cleanDriver(c: CleanReading): CleanDriver {
  const along = c.junctionsPerKm / FULL_JUNCTION_PER_KM;
  const around = c.junctionDensity / FULL_JUNCTION_DENSITY;
  if (along > 0 || around > 0) return along > around ? 'junctionsPerKm' : 'junctionDensity';
  return c.uglyFrac > 0 ? 'ugly' : 'none';
}

/** The provisional-cleanliness note, naming the term that actually bound the score. */
export function cleanProxyNote(c: CleanReading): string {
  switch (cleanDriver(c)) {
    case 'junctionsPerKm':
      return `Clean is still the free proxy, and here it is the ${proxyValue(c.junctionsPerKm)} junctions per km teeing into this stretch that hold it down.`;
    case 'junctionDensity':
      return `Clean is still the free proxy, and here it is the ${proxyValue(c.junctionDensity)} road ends per km² in the country around this stretch that hold it down.`;
    case 'ugly':
      return `Clean is still the free proxy. Nothing tees into this stretch — what takes it down is the ${Math.round(c.uglyFrac * 100)}% of it sitting inside industrial, quarry or retail land.`;
    default:
      return 'Clean is still the free proxy. Nothing tees into this stretch and the country around it is empty, so the proxy takes nothing off at all.';
  }
}

/**
 * The badge in the card's header: a POSITION IN THIS SHORTLIST, never a score.
 *
 * It replaces a 0-100 composite rendered in the Scan tab's emerald mono badge, which was wrong twice
 * over. Measured on the real corpus over ten (instant x aim) combinations, a shortlist's composites
 * span 70-85, 65-77, 71-85, 74-90, 64-75 and 74-94 — i.e. 11 to 20 points of a hundred-point axis,
 * always somewhere between 64 and 94. (An earlier revision of this comment claimed a span of 87 to
 * 100, which no combination produced; the conclusion survives the correction, the number did not.)
 * Two digits out of a hundred that only ever move across a fifth of their range carry almost no
 * information while implying a precision that kappa = 0.53 cannot support — and this module's own
 * header forbids showing "a match %", which a two-digit score out of 100 is.
 * Separately, reelScore.ts:16-19 is explicit that a window score and a ride score are different
 * quantities that merely share an axis, and rendering them in one badge invited the comparison.
 *
 * A rank makes no claim about magnitude, no claim about the gap to the next mark, and shares no
 * scale with anything in the Scan tab. Naming the total with it is what keeps it honest: "#3" alone
 * would sound like a podium, "#3 of 40" says what it is.
 */
export function shortlistBadge(rank: number, total: number): string {
  return total > 0 ? `#${rank} of ${total}` : `#${rank}`;
}

/** Where the sun sits relative to the rider, as a rider would say it. */
function sunSidePhrase(sunSide: ReelMark['light']['sunSide']): string {
  switch (sunSide) {
    case 'left':
      return 'on your left';
    case 'right':
      return 'on your right';
    case 'ahead':
      return 'ahead of you';
    case 'behind':
      return 'behind you';
    default:
      return 'below the horizon';
  }
}

/**
 * Wall clock in the rider's own locale — the card's whole job is to name an hour to be there.
 *
 * Exported because ReelPanel prints the same hours (the shoot window, the golden peak) directly
 * above this card. It grew its own identical copy when the two files were written in parallel; a
 * drift between them would put two different time formats in one panel, so there is one.
 */
export function clock(d: Date): string {
  return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

export interface ShootCardProps {
  mark: ReelMark;
  /** 1-based position in the ranked list, so the card and the map arrow agree. */
  rank: number;
  /** How many marks that list holds — a rank means nothing without it. */
  total: number;
  /** The instant the mark was scored for — the answer to "be there at". */
  at: Date;
  units: Units;
  /** True while `enrichMarks` is still in flight. The ONLY thing that separates a terrain reading
   *  that has not arrived from one that never will — see {@link terrainRead}. */
  refining: boolean;
  onBack: () => void;
  onLocate: (mark: ReelMark) => void;
}

/**
 * THE EMITTED SIDE IS ALWAYS `right`, OR THERE IS NO SIDE. Stated here because this card used to
 * carry a whole branch for `left` — an amber colour, and a paragraph apologising that the boom was
 * on the other verge — and a future reader looking at `Side` alone would restore it.
 *
 * It holds structurally, not by luck. `pickDirection`'s second step exists to put the backdrop on
 * the boom side: only one of a window's two directions can put a given verge on the right, the
 * composite is identical either way (the scalar backdrop metric is the BETTER of the two sides and
 * so survives the flip, and cleanliness and drama have no direction at all), so whenever a window
 * has a backdrop on either verge the direction that films it is the one emitted. Measured across all
 * 1,417 windows x 10 (instant x aim) combinations of the real corpus: zero marks with
 * `backdropSide === 'left'`, including the 221 windows whose forward-order left verge is the better
 * one. Those 221 come back as `reverse`.
 *
 * If a `left` mark ever appears, the bug is in `pickDirection`, not here — do not paint it, fix it.
 */
export function ShootCard({ mark, rank, total, at, units, refining, onBack, onLocate }: ShootCardProps) {
  const [lat, lon] = mark.window.mid;
  const heading = backdropHeading(mark.travelBearingDeg, mark.backdropSide);
  const side = mark.backdropSide;
  const reading = side ? mark.backdrop[side] : null;

  const len = (m: number) => coarseLength(m, units);

  // Both sides are filled from one `readFall`, so either answers for the pair — and asking the mark
  // rather than `reading` means the state is known even when no side cleared the bar, which is
  // precisely the case a missing DEM causes.
  const terrain = terrainRead(mark.backdrop.right.fall, refining);
  const relief = terrainClause(terrain);

  // The two backdrop mechanisms are independent and either can be the one that fired, so the line
  // reports whichever did rather than picking a house favourite.
  const backdropParts: string[] = [];
  if (reading?.fall && reading.fall.fallM > 0) {
    const scale = landformScaleLabel(reading.fall.atM, units);
    backdropParts.push(
      scale ? `${len(reading.fall.fallM)} of fall, ${scale} out` : `${len(reading.fall.fallM)} of fall`,
    );
  }
  if (reading?.waterM != null) backdropParts.push(`open water at ${len(reading.waterM)}`);
  if (relief) backdropParts.push(relief);

  const lowSun = mark.light.sunElevationDeg < 10;
  const anyRelief = reading?.fall != null && (reading.fall.fallM > 0 || reading.fall.riseM > 0);
  const anyWater = mark.backdrop.left.waterM != null || mark.backdrop.right.waterM != null;

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <button
          onClick={onBack}
          className="min-h-[44px] px-2 -ml-2 text-[11px] font-bold text-emerald-400 hover:underline shrink-0"
        >
          ← All shots
        </button>
        {/* Slate, not the Scan tab's emerald — the two must not be read on one scale. */}
        <span className="ml-auto font-mono text-[11px] font-bold text-slate-300 bg-slate-800/70 border border-slate-700 px-2 py-1 rounded-md shrink-0">
          {shortlistBadge(rank, total)}
        </span>
      </div>

      <div>
        <h2 className="text-sm font-black text-slate-100 leading-tight">
          {mark.roadName || 'Unnamed road'}
        </h2>
        <p className="text-[12px] text-emerald-400 font-bold mt-1">
          Ride it {rideDirectionPhrase(mark.travelBearingDeg)} — heading {Math.round(mark.travelBearingDeg)}°
        </p>
        <p className="text-[11px] text-slate-300 mt-0.5">
          Be there at {clock(at)} · sun {Math.round(mark.light.sunElevationDeg)}° at{' '}
          {Math.round(mark.light.sunAzimuthDeg)}°, {sunSidePhrase(mark.light.sunSide)}
        </p>
      </div>

      <BackdropFrame lat={lat} lon={lon} heading={heading} side={side} road={mark.roadName} />

      <div className="bg-slate-950/50 px-3 py-2.5 rounded-xl border border-slate-800">
        <p className="text-[11px] text-slate-200 leading-snug">
          <span className="font-bold text-slate-100">Backdrop:</span>{' '}
          {side ? (
            <>
              {/* Emerald unconditionally: an emitted side is `right`, which is the side the boom
                  films, and there is no second case to colour differently. See the invariant on
                  {@link ShootCard}. */}
              <span className="text-emerald-400 font-bold">on your {side}</span>
              {backdropParts.length > 0 && <> — {backdropParts.join(' · ')}</>}
            </>
          ) : (
            noBackdropPhrase(terrain)
          )}
        </p>
      </div>

      <div className="bg-slate-950/50 px-3 py-3 rounded-xl border border-slate-800 flex flex-col gap-2.5">
        {REEL_METRIC_ROWS.map(({ key, label, hint }) => (
          <MetricBar key={key} label={label} hint={hint} value={mark.metrics[key]} />
        ))}
        {/* One note per refinement, because the two are fetched independently and either can fail
            alone. Terrain leads: it is the heavier loss, and it is the one that used to fail in
            total silence — `clean.provisional` only ever covered the built-up half. */}
        {terrain === 'unavailable' && (
          <p className="text-[10px] text-amber-400/90 leading-snug pt-0.5">
            Backdrop here is open water only. The ground-relief lookup did not land, so a valley
            falling away beside this road would not show up in that bar at all.
          </p>
        )}
        {mark.clean.provisional && (
          <p className="text-[10px] text-slate-400 leading-snug pt-0.5">
            {cleanProxyNote(mark.clean)} The built-up count refines it in the background.
          </p>
        )}
      </div>

      {mark.tags.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {mark.tags.map((t) => (
            <span
              key={t}
              title={t === 'water' ? 'Water is PRESENT within 400 m. Nothing here models whether you can see it.' : undefined}
              className="px-2 py-1 rounded-lg text-[10px] font-bold bg-emerald-500/10 text-emerald-400 border border-emerald-500/25"
            >
              {t}
              {t === 'water' && <span className="text-slate-400 font-normal"> · presence</span>}
            </span>
          ))}
        </div>
      )}

      <div className="grid grid-cols-2 gap-2">
        <button
          onClick={() => onLocate(mark)}
          className="min-h-[44px] rounded-xl bg-slate-800 border border-slate-700 text-[12px] font-bold text-slate-100 active:scale-[.98] transition-all"
        >
          <span aria-hidden>📍</span> Show on map
        </button>
        <a
          href={streetViewDeepLink(lat, lon, heading)}
          target="_blank"
          rel="noopener noreferrer"
          className="min-h-[44px] grid place-items-center rounded-xl border border-emerald-500/30 text-[12px] font-bold text-emerald-400 active:scale-[.98] transition-all"
        >
          <span>
            <span aria-hidden>📷</span> Street View <span aria-hidden>↗</span>
          </span>
        </a>
      </div>

      {/* Honesty. Understatement is the correct register: the numbers above are real measurements of
          map data, and map data is not a photograph. */}
      <div className="text-[10px] text-slate-400 leading-relaxed space-y-1.5 pb-1">
        <p>
          Every score here is measured from map data and terrain, not from pictures. Worth confirming
          in Street View before you plan an evening around it.
        </p>
        {lowSun && anyRelief && (
          <p>
            The sun model uses a flat horizon. In steep country the sun goes behind the ridge well
            before it reaches 0° — measured, a 2.02° skyline at Zoar Valley costs 42% of the
            direct-sun window and 3.13° at Letchworth costs 59%, against 0% out on the Genesee plain.
            With the sun this low, treat the light here as the optimistic case.
          </p>
        )}
        {anyWater && (
          <p>
            “Water” means water is there, not that you will see it. There is no occlusion model —
            trees, a fence or a shed can sit between the road and the lake.
          </p>
        )}
      </div>
    </div>
  );
}

/**
 * The confirmation frame: Street View looking square across the road at the backdrop side.
 *
 * The no-key path is preserved rather than degraded to nothing, because the site has to work
 * without a Google key: no key (or a location with no panorama) falls back to a labelled
 * placeholder plus the keyless deep link, which always works.
 */
function BackdropFrame({
  lat,
  lon,
  heading,
  side,
  road,
}: {
  lat: number;
  lon: number;
  heading: number;
  side: Side | null;
  road: string;
}) {
  const [loaded, setLoaded] = useState(false);
  const [failed, setFailed] = useState(false);
  const src = streetViewStaticUrl(lat, lon, heading, { size: '640x400' });
  const facing = side ?? 'right';

  return (
    <figure className="m-0">
      <div className="relative aspect-[16/10] w-full rounded-xl border border-slate-800 overflow-hidden bg-slate-900/40">
        {src && !failed ? (
          <>
            {!loaded && <div className="absolute inset-0 motion-safe:animate-pulse bg-slate-800" aria-hidden />}
            <img
              src={src}
              alt={`Street View on ${road || 'this road'}, looking ${facing} at the backdrop`}
              loading="lazy"
              decoding="async"
              onLoad={() => setLoaded(true)}
              onError={() => setFailed(true)}
              className={`w-full h-full object-cover ${loaded ? 'opacity-100' : 'opacity-0'}`}
            />
          </>
        ) : (
          <div className="w-full h-full grid place-items-center text-center p-4">
            <div>
              <div className="text-3xl" aria-hidden>📷</div>
              <p className="mt-1.5 text-[10px] text-slate-400 leading-snug">
                {hasGoogleKey() ? 'No Street View imagery here' : 'Street View imagery needs a Maps key'}
              </p>
              <a
                href={streetViewDeepLink(lat, lon, heading)}
                target="_blank"
                rel="noopener noreferrer"
                className="mt-2 inline-flex min-h-[44px] items-center text-[11px] font-bold text-emerald-400 hover:underline"
              >
                Open in Street View ↗
              </a>
            </div>
          </div>
        )}
      </div>
      <figcaption className="mt-1.5 text-[10px] text-slate-400 leading-snug">
        Looking {facing} at {Math.round(heading)}° — square across the road, the way the boom points.
      </figcaption>
    </figure>
  );
}

/** One 0–10 dimension. Whole points only: a tenth of a point is far below what kappa = 0.53 can carry. */
function MetricBar({ label, hint, value }: { label: string; hint: string; value: number }) {
  const v = Math.max(0, Math.min(10, value));
  return (
    <div className="flex items-center gap-2.5" title={hint}>
      <span className="w-16 shrink-0 text-[11px] font-semibold text-slate-300">{label}</span>
      <div className="flex-1 h-2 rounded-full bg-slate-800 overflow-hidden" aria-hidden>
        <div className="h-full rounded-full bg-emerald-500" style={{ width: `${v * 10}%` }} />
      </div>
      <span className="w-9 shrink-0 text-right font-mono text-[11px] text-emerald-400">
        {Math.round(v)}<span className="text-slate-500">/10</span>
      </span>
    </div>
  );
}
