import type { ReactNode } from 'react';
import { LocationSearch } from './LocationSearch';
import { REEL_METRIC_ROWS, ShootCard, clock, rideDirectionPhrase } from './ShootCard';
import { distanceLabel, fromUnits, toUnits } from '../lib/units';
import { scoreWindows, selectMarks, type ReelOptions } from '../lib/reelScore';
import type { Units } from '../lib/preferences';
import type { SavedLocation } from '../lib/settings';
import type { AreaScan } from '../lib/overpass';
import type { ShootWindow } from '../lib/reelPlan';
import type { CameraAim, ReelMark, ReelMetrics } from '../lib/reelTypes';

/**
 * The Reel tab's panel: pick a place, an evening, and a camera; get back a ranked list of 400 m
 * stretches with a direction of travel attached to each one.
 *
 * The controls deliberately reuse the Scan tab's idioms — the same `LocationSearch`, the same
 * radius slider, the same "adjust weights" disclosure over a set of 0-1 sliders — because a second
 * control language for the same shape of question is how an app starts feeling like two apps. The
 * one genuinely new control is the shoot instant, which is the input Scan has no equivalent of.
 *
 * Weights are exposed rather than buried for a specific reason recorded in reelTypes.ts:
 * `REEL_WEIGHTS` is invented, not measured. There is no ground truth that could calibrate it, so
 * the honest presentation is a set of round numbers the rider can move.
 */

/**
 * Map/list colour by whether a mark has a backdrop at all. TWO colours, not three, and the missing
 * third one is the point.
 *
 * There used to be an amber `left`, and it was unreachable: measured across all 1,417 windows x 10
 * (instant x aim) combinations of the real corpus, no mark is ever emitted with
 * `backdropSide === 'left'` — including the 221 windows whose forward-order LEFT verge is the better
 * one, which come back as `reverse` instead. That is `pickDirection`'s second step doing exactly its
 * job: only one of a window's two directions can put a given verge on the right, the composite is
 * identical either way, so the direction that films the backdrop is always the one emitted.
 *
 * So a `left` swatch was a legend entry for a state the rider can never see, over a `Side` type that
 * is still correct and still two-sided everywhere a `PerSide` reading is read. Emerald means the
 * boom films it; slate means neither verge cleared `BACKDROP_MIN`. A `left` mark would be a bug in
 * `pickDirection` and would show up here as slate — the honest rendering of "this is not the case
 * the palette describes" — rather than being quietly painted as if it were expected.
 *
 * Exported so the map arrows in App.tsx and the dots in this list cannot drift apart; a rider
 * matching a list row to an arrow is matching on colour.
 */
export const MARK_SIDE_COLOR = {
  right: '#34d399',
  none: '#94a3b8',
} as const;

export const markColor = (m: ReelMark): string =>
  m.backdropSide === 'right' ? MARK_SIDE_COLOR.right : MARK_SIDE_COLOR.none;

/**
 * The shortlist a set of weights earns, from a pool of scored windows. THE ONLY place the panel's
 * weight sliders become a list.
 *
 * DELIBERATELY A ONE-LINER, because the value is that it exists at all. App used to apply the
 * weights with `marks.map(m => reelComposite(m.metrics, w)).sort()` over the shortlist already on
 * screen, which reelScore.ts forbids in as many words — both non-max suppression and the mark limit
 * consume `mark.score`, so the weights in force decide WHICH ~40 of a scan's ~1,400 windows survive,
 * not merely what order they come back in. Measured on the real corpus with drama weighted to 1 and
 * everything else 0, that re-sort left 37 of the 40 correct marks unreachable: the panel's top-5
 * drama read 10, 10, 10, 8.6, 6.5 against a true 10, 10, 10, 10, 10.
 *
 * `reelShortlist(reelPool(scan, a), b)` equals `buildMarks(scan, b)` for any weights `a` and `b` —
 * that is reelScore's contract, and it is pinned at this level too because this is the level the bug
 * shipped at. The split is worth holding: on a real 30 km Buffalo scan (300 roads, 1,404 windows)
 * the pool costs 300 ms to build and 12-14 ms to re-select from, and it depends on the scan, the
 * shoot instant and the camera aim — never on the weights.
 *
 * It lives here rather than in App for the same reason `instantFrom` does: App imports Leaflet at
 * module scope, which touches `document` on load, so nothing trapped there can be reached by a test
 * at all — and untested App wiring is exactly how the re-sort shipped.
 */
export function reelPool(scan: AreaScan, opts: ReelOptions): ReelMark[] {
  return scoreWindows(scan, opts);
}

export function reelShortlist(pool: ReelMark[], opts: ReelOptions): ReelMark[] {
  return selectMarks(pool, opts);
}


// ------------------------------------------------------------------------------------------------
// The shoot instant, as the rider types it
// ------------------------------------------------------------------------------------------------
//
// These live beside the two inputs they parse rather than in App, and that is deliberate on both
// counts. reelPlan.ts is timezone-free by design and its header says the wall-clock conversion
// belongs in the UI layer; this panel owns the `date`/`time` strings, so this IS that layer. And
// App imports Leaflet at module scope, which touches `document` on load, so anything trapped in
// App.tsx cannot be reached by a test at all — which is exactly how the bug below shipped.

const pad2 = (n: number) => String(n).padStart(2, '0');

/** A `Date` as an `<input type="date">` value, in the rider's own wall clock. */
export const toDateInput = (d: Date): string =>
  `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;

/** A `Date` as an `<input type="time">` value, in the rider's own wall clock. */
export const toTimeInput = (d: Date): string => `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;

/** The exact shapes `<input type="date">` and `<input type="time">` emit. Anything else is a rider
 *  mid-edit, and {@link instantFrom} refuses it — see the measured leniency recorded there. */
const DATE_SHAPE = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIME_SHAPE = /^\d{2}:\d{2}(:\d{2})?$/;

/**
 * The one place a rider's wall clock becomes an absolute instant — or `null` when it is not one yet.
 *
 * `yyyy-mm-ddTHH:mm` with no offset is parsed as LOCAL time by spec, which is exactly what a rider
 * means by "half eight on Saturday", including across a DST boundary.
 *
 * NULL IS THE WHOLE POINT, and it replaces a fallback to `new Date()`. An `<input type="date">`
 * emits `''` mid-edit, so `new Date('T20:15')` is Invalid and used to become NOW: every transient
 * empty value was a DISTINCT instant, so it cleared the rebuild debounce on its own, rescored the
 * whole window pool, and fired Open-Meteo requests for an evening the rider never asked for. This whole
 * category is about a SPECIFIC time, so quietly scoring a different one is worse than showing
 * nothing — the caller holds the last instant the rider actually named (see {@link holdInstant}).
 *
 * `Number.isNaN` ALONE IS NOT ENOUGH, and that is measured rather than defensive. Where the ISO
 * grammar does not match, V8 falls back to a lenient legacy parser that answers a real Date for
 * things that are not one, silently and plausibly (node 22, 2026-08-02):
 *   '2026-08T20:15'    -> Sat Aug  1 2026 20:15   a year-month prefix becomes the 1st
 *   '2026T20:15'       -> Thu Jan  1 2026 20:15   a bare year becomes Jan 1
 *   '2026-02-31T20:15' -> Tue Mar  3 2026 20:15   an impossible day rolls into the next month
 * Every one of those is the same failure the `new Date()` fallback was: a specific instant the
 * rider never named. So the shape is checked first, and the parse is then required to ROUND-TRIP to
 * the day that was typed. The round trip is on the DATE only — a wall-clock time that does not
 * exist (02:30 on a spring-forward morning) legitimately resolves to a shifted instant on the same
 * day, and that is the right answer rather than a rejection.
 */
export function instantFrom(date: string, time: string): Date | null {
  const parts = DATE_SHAPE.exec(date);
  if (!parts) return null;
  const wall = time || '00:00';
  if (!TIME_SHAPE.test(wall)) return null;

  const at = new Date(`${date}T${wall}`);
  if (Number.isNaN(at.getTime())) return null;
  const sameDay =
    at.getFullYear() === +parts[1] && at.getMonth() + 1 === +parts[2] && at.getDate() === +parts[3];
  return sameDay ? at : null;
}

/**
 * The instant the rider has named, or the last one they did.
 *
 * Returning `prev` BY IDENTITY is load-bearing, not a micro-optimisation: App keys the debounced
 * rebuild on `reelAt.getTime()`, so an unchanged instant is what stops a half-typed date from
 * triggering a rebuild and a DEM batch at all.
 */
export function holdInstant(prev: Date, date: string, time: string): Date {
  return instantFrom(date, time) ?? prev;
}

/**
 * Local noon of an instant's own day — the day anchor handed to `shootWindow`.
 *
 * `shootWindow` selects a day by its UTC date and ignores the time of day within it, so passing the
 * rider's chosen shoot instant directly would ask for the WRONG EVENING west of Greenwich: 8 pm in
 * New York is already the next UTC day. Local noon is the instant furthest from both UTC midnights,
 * so it names the intended day for every offset in (-12, +12).
 *
 * Takes the held instant rather than the raw date string so an incomplete input cannot move the
 * evening either — same reason as {@link holdInstant}.
 */
export function dayAnchor(at: Date): Date {
  return new Date(at.getFullYear(), at.getMonth(), at.getDate(), 12, 0, 0, 0);
}

/**
 * The middle of the evening's best light: the golden band when there is one, otherwise the middle
 * of the wider usable stretch.
 *
 * The MIDDLE rather than the start, because the rider will nudge it either way and an anchor inside
 * the peak beats one balanced on its edge. `shootWindow` never returns null and pins an unusable
 * day to solar noon, which is that day's best light even when its best is nothing — so this is
 * always a real instant to show.
 */
export function peakInstant(w: ShootWindow): Date {
  const band = w.golden ?? { start: w.start, end: w.end };
  return new Date((band.start.getTime() + band.end.getTime()) / 2);
}

/**
 * Quiet time (ms) before a changed shoot instant or camera aim rebuilds the marks.
 *
 * THE DEBOUNCE IS NOT THE RATE LIMITER, and pretending it was is how the previous value got set.
 * Open-Meteo was measured returning HTTP 429 at ~10-15 requests inside 2 minutes. At the old 350 ms
 * a rider who pauses between nudges can still clear it about 340 times in that window, and 700 ms
 * only halves that to ~170 — both an order of magnitude past the limit. No debounce short of ~8 s
 * would bound it, and an 8 s debounce is not a control, it is a lag. What actually bounds the
 * requests is the window-id-keyed cache in reelTerrain.ts: probe geometry is a function of the
 * window alone and does not depend on the shoot instant, so every rebuild after the first costs
 * ZERO elevation requests for windows already probed.
 *
 * So this number is spent on the thing it can genuinely buy: scoring the pool ({@link reelPool}) is
 * measured at ~300 ms on the main thread for a real 30 km scan, so 700 ms is a bit over two
 * rebuilds' worth of settle — enough that stepping the time field does not queue a rebuild per
 * keystroke, and still inside the ~1 s at which a control stops feeling connected to the input. The
 * placement inside that range is a judgement call; the two bounds are measured.
 *
 * The SAME number debounces the weight sliders, which do not rebuild the pool at all (12-14 ms to
 * re-select from it). It is not doing the same job there — a dragged range input emits a change per
 * pointer move, so what it absorbs is a stream of re-selections nobody has stopped scrubbing yet.
 * One timer rather than two because two controls settling at visibly different speeds reads as a
 * bug, and 700 ms is inside the tolerable range for both.
 */
export const REEL_REBUILD_DEBOUNCE_MS = 700;

// ------------------------------------------------------------------------------------------------
// Degradation
// ------------------------------------------------------------------------------------------------

/**
 * What the two refinements did NOT deliver, in the rider's words. Empty while they are still in
 * flight, and empty when both landed.
 *
 * THE TWO HALVES FAIL INDEPENDENTLY, which is the bug this exists to close. `enrichMarks` awaits the
 * DEM lateral fall and the built-up query together and each one degrades to null on its own, so
 * `CleanReading.provisional` — the panel's only notice before this — reported the BUILT-UP half
 * exclusively. A total DEM failure therefore left `backdrop`, the heaviest dimension at 0.40, resting
 * on open water alone with nothing anywhere saying so; the shoot card even said the relief was "not
 * read yet" forever. The design doc is explicit that a silent gap "reads to the rider as: we checked
 * everywhere and found nothing", which is a different and much worse claim than "we did not look".
 *
 * THE FIRST MARK IS THE PROBE for both halves, and it is a sound one because `DEFAULT_MARK_LIMIT`
 * equals `MAX_PROBE_WINDOWS`: every mark in this list is inside both budgets, so a reading still
 * missing on the strongest mark once the refinement has settled means the lookup genuinely did not
 * land, rather than not having reached this mark yet. `readFall` fills both sides of a window from
 * one elevation array, so `right` answers for `left` too.
 *
 * WHAT THE PROBE CANNOT SEE, since it is one mark and not forty: `fetchLateralFall` can return a
 * PARTIAL map — a failed fetch that still has cache hits hands back the hits — so a run where the
 * top mark was cached from an earlier area and the rest failed reads as fully landed here. That is
 * not left to chance, it is just not this notice's job: the shoot card derives the same three states
 * per mark from that mark's own `fall`, so a rider opening an unprobed mark is told so on the card.
 * Reading every mark here instead would fire this notice on the legitimate truncation a caller gets
 * by asking for more marks than the probe budget covers.
 *
 * Terrain goes first because it is the heavier loss.
 */
export function refinementGaps(marks: ReelMark[], refining: boolean): string[] {
  if (refining || !marks.length) return [];
  const gaps: string[] = [];
  if (marks[0].backdrop.right.fall == null) {
    gaps.push(
      'The ground-relief lookup did not land, so backdrop rests on open water alone — a road with ' +
        'a valley beside it and no lake reads as flat here.',
    );
  }
  if (marks[0].clean.provisional) {
    gaps.push(
      'The built-up count did not land, so cleanliness still rests on the junction proxy — ' +
        'measured, just coarser.',
    );
  }
  return gaps;
}

export interface ReelPanelProps {
  // --- where -------------------------------------------------------------------------------
  center: SavedLocation;
  isDefaultCenter: boolean;
  defaultLabel: string;
  onRecenter: (loc: SavedLocation) => void;
  onSetDefault: () => void;
  onUseDefault: () => void;
  radiusKm: number;
  onRadiusChange: (km: number) => void;
  units: Units;

  // --- when --------------------------------------------------------------------------------
  /** `yyyy-mm-dd` in the rider's own wall clock; App turns the pair into an instant. */
  date: string;
  /** `HH:mm` in the rider's own wall clock. */
  time: string;
  onDateChange: (v: string) => void;
  onTimeChange: (v: string) => void;
  shoot: ShootWindow;
  onUsePeakLight: () => void;

  // --- how ---------------------------------------------------------------------------------
  aim: CameraAim;
  onAimChange: (a: CameraAim) => void;
  weights: ReelMetrics;
  onWeightChange: (k: keyof ReelMetrics, v: number) => void;
  onResetWeights: () => void;

  // --- results -----------------------------------------------------------------------------
  marks: ReelMark[];
  /** The instant the marks were scored for, so the card can say "be there at". */
  at: Date;
  selected: ReelMark | null;
  onSelect: (m: ReelMark | null) => void;
  onLocate: (m: ReelMark) => void;
  /** True while `enrichMarks` is still in flight — a note, never a blocker. */
  refining: boolean;
  hasRun: boolean;
  view: 'setup' | 'shots';
  onViewChange: (v: 'setup' | 'shots') => void;
  /** The primary action. App owns it so the mobile sheet can pin the same node above the scroll. */
  action: ReactNode;
  /** False on mobile, where `action` is already pinned in the sheet's top region. */
  showAction: boolean;
}

export function ReelPanel(props: ReelPanelProps) {
  const { marks, selected, units, shoot } = props;
  const showShots = marks.length > 0 && props.view === 'shots';

  const gaps = refinementGaps(marks, props.refining);
  // What the two date/time inputs currently spell, if they spell anything. Null means the rider is
  // mid-edit and `props.at` is the last instant they actually named — which the panel says out loud
  // rather than letting the form and the scores disagree in silence.
  const named = instantFrom(props.date, props.time);

  return (
    <div className="flex flex-col gap-3">
      <div>
        <h2 className="text-xs font-bold uppercase tracking-wider text-emerald-400">Shot finder</h2>
        <p className="text-[10px] text-slate-400">
          Ranks 400 m stretches for one evening — which way to ride each one, and when to be there
        </p>
      </div>

      {marks.length > 0 && (
        <div role="group" aria-label="Shot finder view" className="grid grid-cols-2 gap-0.5 bg-slate-950/60 p-1 rounded-xl border border-slate-800">
          <button
            onClick={() => props.onViewChange('setup')}
            aria-pressed={props.view === 'setup'}
            className={`min-h-[40px] rounded-lg text-[11px] font-bold transition-all ${props.view === 'setup' ? 'bg-emerald-500 text-slate-950' : 'text-slate-400'}`}
          >
            Setup
          </button>
          <button
            onClick={() => props.onViewChange('shots')}
            aria-pressed={props.view === 'shots'}
            className={`min-h-[40px] rounded-lg text-[11px] font-bold transition-all ${props.view === 'shots' ? 'bg-emerald-500 text-slate-950' : 'text-slate-400'}`}
          >
            Shots · {marks.length}
          </button>
        </div>
      )}

      {/* The card is a state OF the shots view, not a third view: tapping Setup while a card is
          open shows the form again with the mark still selected and still highlighted on the map,
          and tapping Shots comes straight back to it. */}
      {showShots && selected ? (
        <ShootCard
          mark={selected}
          rank={Math.max(1, marks.findIndex((m) => m.id === selected.id) + 1)}
          total={marks.length}
          at={props.at}
          units={units}
          refining={props.refining}
          onBack={() => props.onSelect(null)}
          onLocate={props.onLocate}
        />
      ) : showShots ? (
        <>
          {props.refining ? (
            <p className="text-[10px] text-slate-400 flex items-center gap-1.5">
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 motion-safe:animate-pulse shrink-0" aria-hidden />
              Refining with terrain and built-up data — the list is already usable.
            </p>
          ) : (
            gaps.map((g) => (
              <p key={g} className="text-[10px] text-amber-400/90 leading-snug">
                {g}
              </p>
            ))
          )}

          <div className="space-y-2">
            {marks.map((m, i) => (
              <button
                key={m.id}
                onClick={() => props.onSelect(m)}
                aria-current={selected?.id === m.id ? 'true' : undefined}
                style={{
                  borderColor: markColor(m),
                  boxShadow: selected?.id === m.id ? `0 0 0 2px ${markColor(m)}66` : undefined,
                }}
                className={`w-full flex justify-between items-center gap-2 p-3 rounded-xl border-2 active:scale-[.99] transition-all text-left ${selected?.id === m.id ? 'bg-emerald-500/10' : 'bg-slate-900/40'}`}
              >
                <div className="min-w-0 pr-1">
                  <div className="flex items-center gap-1.5">
                    <span className="font-mono text-[10px] font-black text-slate-400 shrink-0">#{i + 1}</span>
                    <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ background: markColor(m) }} aria-hidden />
                    <h4 className="font-bold text-[13px] text-slate-100 truncate">{m.roadName || 'Unnamed road'}</h4>
                  </div>
                  <p className="text-[10px] text-slate-400 truncate mt-0.5">
                    ride it {rideDirectionPhrase(m.travelBearingDeg)} ·{' '}
                    {m.backdropSide ? `backdrop ${m.backdropSide}` : 'no clear side'}
                    {m.tags.length > 0 && ` · ${m.tags.join(', ')}`}
                  </p>
                </div>
                {/* NO SCORE HERE. The composite is a real measurement, but measured on the real
                    corpus over ten (instant x aim) combinations a shortlist's composites span
                    70-85, 65-77, 71-85, 74-90, 64-75 and 74-94 — 11 to 20 points of a hundred-point
                    axis, always between 64 and 94. (An earlier revision of this comment claimed a
                    span of 87 to 100, which no combination produced.) That narrow a band, under weights that
                    are invented rather than measured, over a ground truth at kappa = 0.53: two
                    digits out of a hundred read as a match percentage — which ShootCard's header
                    forbids outright — while carrying only the ORDER, which the `#n` on the left
                    already says exactly. It was also rendered in the Scan tab's emerald mono badge,
                    and reelScore.ts:16-19 is explicit that a window score and a ride score must
                    never be read on one scale. */}
                <span className="text-slate-500 text-[15px] shrink-0" aria-hidden>›</span>
              </button>
            ))}
          </div>

          {/* The amber left-hand entry is gone from this legend: it described a state no mark can
              be in. See {@link MARK_SIDE_COLOR} for why it cannot occur and why that is correct. */}
          <p className="text-[10px] text-slate-500 leading-snug">
            Arrows on the map point the way to ride, drawn over the stretch itself. Emerald = backdrop
            on your right, the side the boom films — every stretch with a view is pointed the way that
            puts it there. Grey = neither side cleared the bar. They are listed strongest first — but
            the spread across a shortlist is narrow and the ground truth is one rider’s evening, so
            read the order as a queue to check, not as a gap between them.
          </p>
        </>
      ) : (
        <>
          <LocationSearch
            value={props.center}
            isDefault={props.isDefaultCenter}
            defaultLabel={props.defaultLabel}
            onSelect={props.onRecenter}
            onSetDefault={props.onSetDefault}
            onUseDefault={props.onUseDefault}
          />

          <div className="bg-slate-950/50 px-3 py-2.5 rounded-xl border border-slate-800 flex flex-col">
            <div className="flex items-baseline justify-between gap-2">
              <label htmlFor="reel-radius" className="text-[11px] font-bold text-slate-300">Search radius</label>
              <span className="font-mono text-emerald-400 font-bold text-sm">
                {Math.round(toUnits(props.radiusKm, units))} {distanceLabel(units)}
              </span>
            </div>
            <input
              id="reel-radius"
              className="w-full"
              type="range"
              min={Math.round(toUnits(5, units))}
              max={Math.round(toUnits(30, units))}
              value={Math.round(toUnits(props.radiusKm, units))}
              aria-label={`Search radius in ${units === 'mi' ? 'miles' : 'kilometers'}`}
              aria-valuetext={`${Math.round(toUnits(props.radiusKm, units))} ${units === 'mi' ? 'miles' : 'kilometers'}`}
              onChange={(e) => props.onRadiusChange(fromUnits(+e.target.value, units))}
            />
            <p className="text-[10px] text-slate-500">Drag the green pin on the map to move the area.</p>
          </div>

          {/* When. The two deliverables of this category are a direction and an hour, so the hour is
              a first-class control rather than a filter. `shootWindow` supplies the evening's usable
              stretch and its golden band; the rider is anchored inside it and free to leave it. */}
          <div className="bg-slate-950/50 px-3 py-2.5 rounded-xl border border-slate-800 flex flex-col gap-2">
            <span className="text-[11px] font-bold text-slate-300">When you will be out</span>
            <div className="grid grid-cols-2 gap-2">
              <div className="flex flex-col gap-1">
                <label htmlFor="reel-date" className="text-[10px] text-slate-400">Date</label>
                <input
                  id="reel-date"
                  type="date"
                  value={props.date}
                  onChange={(e) => props.onDateChange(e.target.value)}
                  className="min-h-[44px] w-full px-2 rounded-lg bg-slate-900/40 border border-slate-700 text-slate-100 text-[12px] font-semibold"
                />
              </div>
              <div className="flex flex-col gap-1">
                <label htmlFor="reel-time" className="text-[10px] text-slate-400">Time</label>
                <input
                  id="reel-time"
                  type="time"
                  value={props.time}
                  onChange={(e) => props.onTimeChange(e.target.value)}
                  className="min-h-[44px] w-full px-2 rounded-lg bg-slate-900/40 border border-slate-700 text-slate-100 text-[12px] font-semibold"
                />
              </div>
            </div>
            {/* Mid-edit, the pair spells nothing. Everything below is still scored for the last
                instant the rider actually named, and saying which one beats either silently
                re-scoring at "now" (what this used to do) or blanking a list that is still true. */}
            {named === null && (
              <p className="text-[10px] text-amber-400/90 leading-snug">
                Finish the date and time — everything here is still scored for {clock(props.at)}, the
                last complete time you gave.
              </p>
            )}
            {shoot.usable ? (
              <>
                <p className="text-[10px] text-slate-400 leading-snug">
                  Evening light here runs {clock(shoot.start)}–{clock(shoot.end)}
                  {shoot.golden && <> · peak {clock(shoot.golden.start)}–{clock(shoot.golden.end)}</>}
                  {' '}— about {Math.round(toUnits(shoot.rideKm, units))} {distanceLabel(units)} of road at a steady pace.
                </p>
                <button
                  type="button"
                  onClick={props.onUsePeakLight}
                  className="self-start min-h-[40px] px-2 -ml-2 text-[11px] font-bold text-emerald-400 hover:underline"
                >
                  Jump to the peak
                </button>
              </>
            ) : (
              <p className="text-[10px] text-slate-400 leading-snug">
                The sun never gets high enough here on this date to shoot in. Marks will still rank on
                backdrop, corners and cleanliness — light will score zero for all of them.
              </p>
            )}
          </div>

          {/* Camera. These two want OPPOSITE geometry — the side boom wants the sun across the road,
              the forward angle wants it along the road — so one number cannot serve both and the
              rider has to say which rig is on the bike. */}
          <div className="bg-slate-950/50 p-3 rounded-xl border border-slate-800 flex flex-col gap-2">
            <span className="text-[11px] font-bold text-slate-300">Camera aim</span>
            <div role="group" aria-label="Camera aim" className="grid grid-cols-2 gap-2">
              <AimButton
                active={props.aim === 'side'}
                onClick={() => props.onAimChange('side')}
                label="Side boom"
                hint="Rider + engine against what is beside you. Wants the sun across the road."
              />
              <AimButton
                active={props.aim === 'forward'}
                onClick={() => props.onAimChange('forward')}
                label="Forward / rear"
                hint="Looking down the road. Wants the sun near the way you are pointed."
              />
            </div>
            <p className="text-[10px] text-slate-500 leading-snug">
              Side boom is the default because it is the rig usually mounted — a 360 out to the right.
            </p>
          </div>

          {/* Weights: round numbers, exposed. See the module header. */}
          <div className="bg-slate-950/50 p-3 rounded-xl border border-slate-800 flex flex-col gap-2">
            <div className="flex items-center justify-between">
              <span className="text-[10px] font-bold text-slate-300">What makes a shot, to you</span>
              <button
                onClick={props.onResetWeights}
                className="text-[11px] font-bold text-emerald-400 hover:underline min-h-[40px] px-2 -mr-2"
              >
                Reset
              </button>
            </div>
            <div className="flex flex-col gap-1.5">
              {REEL_METRIC_ROWS.map(({ key, label, hint }) => {
                const pct = weightPercent(props.weights, key);
                return (
                  <div key={key} className="flex items-center gap-2" title={hint}>
                    <span className="w-20 shrink-0 text-[11px] font-semibold text-slate-300">{label}</span>
                    <input
                      type="range"
                      min={0}
                      max={1}
                      step={0.05}
                      value={props.weights[key] ?? 0}
                      aria-label={`${label} importance`}
                      aria-valuetext={`${pct} percent`}
                      onChange={(e) => props.onWeightChange(key, +e.target.value)}
                      className="flex-1"
                    />
                    <span className="w-9 shrink-0 text-right font-mono text-[11px] text-emerald-400">{pct}%</span>
                  </div>
                );
              })}
            </div>
          </div>

          {props.showAction && props.action}

          <p className="text-[10px] text-slate-400 italic leading-snug text-center py-1">
            {props.hasRun && marks.length === 0
              ? 'Nothing here reads as filmable — widen the radius, or try another evening.'
              : 'Scores are measured from road geometry, terrain, water and a solar model — not from photographs. They come from one rider’s evening of good/bad calls, on which the same stretch was once called good and once bad, so treat the list as a shortlist to check in Street View rather than a verdict.'}
          </p>
        </>
      )}
    </div>
  );
}

/** Share of the composite this dimension currently carries. Raw weights are unbounded relative to
 *  each other, so the percentage — not the slider position — is what the rider is actually setting. */
function weightPercent(w: ReelMetrics, key: keyof ReelMetrics): number {
  let sum = 0;
  for (const row of REEL_METRIC_ROWS) sum += Math.max(0, w[row.key] ?? 0);
  return sum > 0 ? Math.round((Math.max(0, w[key] ?? 0) / sum) * 100) : 0;
}

function AimButton({
  active,
  onClick,
  label,
  hint,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  hint: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`min-h-[44px] p-2.5 rounded-xl border text-left transition-all ${active ? 'bg-emerald-500/10 border-emerald-500/40' : 'bg-slate-900/40 border-slate-800'}`}
    >
      <span className={`block text-[12px] font-bold ${active ? 'text-emerald-400' : 'text-slate-200'}`}>{label}</span>
      <span className="block text-[10px] text-slate-400 leading-snug mt-0.5">{hint}</span>
    </button>
  );
}
