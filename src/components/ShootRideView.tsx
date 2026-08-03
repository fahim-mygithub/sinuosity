import { clock } from './ShootCard';
import { distanceLabel, toUnits } from '../lib/units';
import type { Units } from '../lib/preferences';
import type { Chain, NextStep, ScheduledShot, ShootRide } from '../lib/reelRoute';
import type { ReelMark } from '../lib/reelTypes';

/**
 * The evening as one ride, in the order the rider tapped it.
 *
 * THE ORDER HERE IS THE RIDER'S, and that is the one thing this view has to keep straight. A shot's
 * `#n of 40` is its rank on the shortlist; its position in this list is where the rider put it on the
 * road. Nothing reorders, nothing is dropped, and the list is exactly as long as the number of arrows
 * they tapped — so unlike the builder this replaced, there is no accounting to do for shots that are
 * not here. They are not here because nobody tapped them.
 *
 * Arrival times are distance over a planning speed, nothing more. They do not model junctions,
 * villages, or the minutes spent actually filming, so they can only ever be a floor. The view says
 * "from" rather than naming an hour flat, and flags any shot that lands outside the usable light.
 */

/** Ride distance in the rider's units, at the resolution a planning estimate can carry. */
export function rideLength(km: number, units: Units): string {
  return `${Math.round(toUnits(km, units))} ${distanceLabel(units)}`;
}

/**
 * A short hop, at a resolution that survives rounding.
 *
 * {@link rideLength} rounds to the whole unit, which turns every connector under half a mile into
 * "0 mi" — and a list of hops reading 0, 0, 3, 0 looks broken rather than close. Two shots on
 * adjoining roads genuinely are a few hundred metres apart, so the short end needs a decimal.
 */
export function hopLength(km: number, units: Units): string {
  const v = toUnits(km, units);
  return `${v < 10 ? Math.round(v * 10) / 10 : Math.round(v)} ${distanceLabel(units)}`;
}

/** Riding time, as hours and minutes. Excludes filming — see the note above. */
export function rideDuration(minutes: number): string {
  const m = Math.max(0, Math.round(minutes));
  const h = Math.floor(m / 60);
  return h > 0 ? `${h} h ${m % 60} min` : `${m} min`;
}

/**
 * What the ride is shaped like, in a rider's words rather than the type's.
 *
 * `retrace` is called what it is. routeBuilder draws the same distinction for the Scan tab, and the
 * reason is the same: a circuit and a there-and-back-again are different evenings, and a rider who
 * asked for a loop and silently got a retrace would find out at the far end.
 */
export function shapeNote(ride: ShootRide): string {
  if (ride.returnKind === 'circuit') return 'a loop — you come home a different way';
  if (ride.returnKind === 'retrace') return 'a loop, but only by riding back the way you came';
  return 'point to point — it ends at the last shot';
}

/** Shots the rider would reach outside the evening's usable light, if any. */
export function outsideLight(shots: ScheduledShot[]): ScheduledShot[] {
  return shots.filter((s) => s.light !== 'in');
}

/**
 * How far the ride's start sits from the pin the rider dropped, when that is far enough to matter.
 *
 * Unlike the builder this replaces, the start is a shot the rider chose, so this is not a surprise
 * to apologise for — it is the one piece of getting-there the app cannot route, because the scanned
 * corpus frequently has no connected road between a pin and the shots (measured at Ellicottville the
 * gap was 22.7 km). Saying the distance is the honest version of that.
 *
 * 2 km rather than a rounder number because the graph's own junction spacing is the floor here: a
 * pin dropped on open country can be a kilometre or two from the nearest scanned road, and calling
 * that a relocation would cry wolf on the ordinary case.
 */
const START_AWAY_KM = 2;

export function startNote(km: number, units: Units): string | null {
  if (!(km > START_AWAY_KM)) return null;
  return `Your first shot is ${rideLength(km, units)} from the pin — the ride below starts there, and getting to it is your own road.`;
}

export interface Reach {
  /** Shortlist marks that could be tapped next. */
  open: number;
  /** Marks with no route from the end of the chain, or no geometry at all. */
  blocked: number;
}

/** How much of the shortlist is still in play. Shots already chained count as neither. */
export function countReach(steps: Map<string, NextStep>): Reach {
  let open = 0;
  let blocked = 0;
  for (const s of steps.values()) {
    if (s.blocked === null) open++;
    else if (s.blocked !== 'chained') blocked++;
  }
  return { open, blocked };
}

/**
 * What is still reachable, said out loud.
 *
 * This is the honest replacement for the old builder's drop list. The scanned corpus carries
 * secondary, tertiary and unclassified ways but not the residential streets between them, so parts
 * of it are genuinely islands — a real limitation that used to surface only as "10 no road route to
 * them" after a ride had already been built. Here it is a live count, and the arrows it refers to
 * are dimmed on the map before the rider tries them.
 */
export function reachNote(reach: Reach, chained: boolean): string | null {
  if (!chained) return null;
  if (reach.open === 0) {
    return reach.blocked === 0
      ? 'Every shot on the shortlist is in this ride.'
      : 'Nothing else on the shortlist connects to the end of this chain by a road the scan covered. Tap a shot in the ride to cut back, or finish here.';
  }
  if (reach.blocked === 0) return `Any of the other ${reach.open} shots can follow this one.`;
  return `${reach.open} of the remaining ${reach.open + reach.blocked} shots can follow this one — the dimmed arrows sit on roads the scan never connected to here.`;
}

export interface ShootRideViewProps {
  /** The taps so far, in order. */
  chain: Chain;
  /** The chain assembled into a drivable ride. Null while the chain is empty. */
  ride: ShootRide | null;
  /** Every shortlist mark's standing against the end of the chain, keyed by mark id. */
  steps: Map<string, NextStep>;
  /** How many marks the shortlist holds — the denominator for "3 of 40". */
  markCount: number;
  units: Units;
  loop: boolean;
  onLoopChange: (v: boolean) => void;
  /** Cut the chain back to just before this mark. */
  onTruncate: (markId: string) => void;
  onClear: () => void;
  onSelectShot: (m: ReelMark) => void;
  /** Opens the whole ride in a maps app. Null while there is no ride to open. */
  mapsHref: string | null;
}

export function ShootRideView(props: ShootRideViewProps) {
  const { chain, ride, units } = props;
  const dark = ride ? outsideLight(ride.shots) : [];
  const reach = countReach(props.steps);
  const note = reachNote(reach, chain.length > 0);

  if (chain.length === 0) {
    return (
      <div className="flex flex-col gap-3">
        <div className="bg-slate-950/50 px-3 py-3 rounded-xl border border-slate-800">
          <p className="text-[12px] font-bold text-slate-100">Draw the ride yourself</p>
          <p className="text-[11px] text-slate-300 mt-1 leading-snug">
            Tap an arrow on the map to start. Tap the next one and the road between them is found for
            you — in the order you tap, each stretch ridden the way its arrow points.
          </p>
        </div>
        <p className="text-[10px] text-slate-400 leading-snug">
          Arrows go dim once they cannot be reached from where the chain currently ends. Tapping a
          shot that is already in the ride cuts back to it.
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      {ride && (
        <div className="bg-slate-950/50 px-3 py-2.5 rounded-xl border border-slate-800">
          <p className="text-[12px] font-bold text-slate-100">
            {ride.shots.length} of {props.markCount} shots · {rideLength(ride.km, units)}
          </p>
          <p className="text-[11px] text-slate-300 mt-0.5">
            Leave at {clock(ride.depart)} · about {rideDuration(ride.minutes)} of riding, before you
            stop to film anything
          </p>
          <p className="text-[10px] text-slate-400 mt-1">{shapeNote(ride)}</p>
          {startNote(ride.startOffsetKm, units) && (
            <p className="text-[10px] text-amber-400/90 mt-1 leading-snug">
              {startNote(ride.startOffsetKm, units)}
            </p>
          )}
        </div>
      )}

      <ol className="flex flex-col gap-1.5">
        {chain.map((link, i) => {
          const shot = ride?.shots[i];
          const last = i === chain.length - 1;
          return (
            <li key={link.mark.id} className="flex items-stretch gap-1.5">
              <button
                onClick={() => props.onSelectShot(link.mark)}
                className="min-w-0 flex-1 text-left px-3 py-2 rounded-xl bg-slate-900/60 border border-slate-800 active:scale-[.99] transition-all flex items-center gap-2.5"
              >
                <span className="w-6 h-6 shrink-0 grid place-items-center rounded-full bg-emerald-500/15 text-emerald-400 font-mono text-[11px] font-bold">
                  {i + 1}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-[12px] font-bold text-slate-100 truncate">
                    {link.mark.roadName || 'Unnamed road'}
                  </span>
                  <span className="block text-[10px] text-slate-400 truncate">
                    {i === 0 ? 'the ride starts here' : `${hopLength(link.transitKm, units)} on from the last`}
                    {shot && ` · from ${clock(shot.at)}`}
                    {shot && shot.light !== 'in' && (
                      <span className="text-amber-400 font-bold">
                        {' '}· {shot.light === 'late' ? 'after the light' : 'before the light'}
                      </span>
                    )}
                  </span>
                </span>
              </button>
              <button
                onClick={() => props.onTruncate(link.mark.id)}
                aria-label={
                  last
                    ? `Remove ${link.mark.roadName || 'this shot'} from the ride`
                    : `Cut the ride back to before ${link.mark.roadName || 'this shot'}, removing the ${chain.length - i} shots from here on`
                }
                className="w-11 shrink-0 grid place-items-center rounded-xl border border-slate-800 text-slate-500 active:scale-[.97] transition-all"
              >
                <span aria-hidden className="text-[15px] leading-none">×</span>
              </button>
            </li>
          );
        })}
      </ol>

      {note && <p className="text-[10px] text-slate-400 leading-snug">{note}</p>}

      <label className="flex items-center gap-2 min-h-[44px] cursor-pointer px-3 rounded-xl bg-slate-950/50 border border-slate-800">
        <input
          type="checkbox"
          checked={props.loop}
          onChange={(e) => props.onLoopChange(e.target.checked)}
          className="w-4 h-4 accent-emerald-500"
        />
        <span className="text-[11px] font-semibold text-slate-200">Come back to where I started</span>
      </label>

      {dark.length > 0 && (
        <p className="text-[10px] text-amber-400/90 leading-snug">
          {dark.length === 1 ? 'One shot falls' : `${dark.length} shots fall`} outside the usable light
          at this pace. Arrival times are distance over a steady 45 mph and count no stops, so treat
          them as the earliest you could be there, not the hour you will be.
        </p>
      )}

      {props.mapsHref && (
        <a
          href={props.mapsHref}
          target="_blank"
          rel="noopener noreferrer"
          className="min-h-[44px] grid place-items-center rounded-xl border border-emerald-500/30 text-[12px] font-bold text-emerald-400 active:scale-[.98] transition-all"
        >
          <span>
            <span aria-hidden>🧭</span> Open the ride in Maps <span aria-hidden>↗</span>
          </span>
        </a>
      )}

      <button
        onClick={props.onClear}
        className="min-h-[44px] rounded-xl border border-slate-800 text-[11px] font-bold text-slate-400 active:scale-[.99] transition-all"
      >
        Start over
      </button>

      <p className="text-[10px] text-slate-400 italic leading-snug">
        The shots keep the scores from their own cards, which were measured for one instant — the ride
        does not re-score them for the minute you would actually arrive.
      </p>
    </div>
  );
}
