import { clock } from './ShootCard';
import { distanceLabel, fromUnits, toUnits } from '../lib/units';
import type { Units } from '../lib/preferences';
import type { DropReason, ScheduledShot, ShootRide } from '../lib/reelRoute';
import { MAX_SHOTS } from '../lib/reelRoute';
import type { ReelMark } from '../lib/reelTypes';

/**
 * The evening as one ride: the shortlist's best shots in the order that rides shortest, joined by
 * real road, optionally closing back where it started.
 *
 * THE ORDER HERE IS NOT THE SHORTLIST'S ORDER, and that is the one thing this view has to keep
 * straight. A shot's `#n of 40` is its rank; its position in this list is where it falls on the
 * road. Showing both without distinguishing them would invite the reading that shot 1 of the ride is
 * the best shot of the evening, which it is not — it is the one nearest the start.
 *
 * Arrival times are distance over a planning speed, nothing more. They do not model junctions,
 * villages, or the minutes spent actually filming, so they can only ever be a floor. The view says
 * "from" rather than naming an hour flat, and flags any shot that lands outside the usable light.
 */

/** Ride distance in the rider's units, at the resolution a planning estimate can carry. */
export function rideLength(km: number, units: Units): string {
  return `${Math.round(toUnits(km, units))} ${distanceLabel(units)}`;
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
 * A ride can only be built on one connected piece of the scanned network, and the piece carrying the
 * shots is often not the piece under the pin — measured at Ellicottville the gap was 22.7 km. Under
 * this threshold the start is close enough to be the place the rider meant; over it, it is a
 * different place and saying so is the difference between a ride and a surprise.
 *
 * 2 km rather than a rounder number because the graph's own junction spacing is the floor here: a
 * pin dropped on open country can be a kilometre or two from the nearest junction on a road that
 * was scanned, and calling that a relocation would cry wolf on the ordinary case.
 */
const START_AWAY_KM = 2;

export function startNote(km: number, units: Units): string | null {
  if (!(km > START_AWAY_KM)) return null;
  return `Starts ${rideLength(km, units)} from your pin — the shots worth chaining are all on one connected stretch of road, and this is the nearest point on it.`;
}

const DROP_NOTE: Record<DropReason, string> = {
  budget: 'would not fit the distance',
  unreachable: 'no road route to them',
  cap: `past the ${MAX_SHOTS}-shot limit for one ride`,
};

/**
 * Why the ride is shorter than the shortlist, counted by reason.
 *
 * Every considered mark gets a reason, and they are all shown. A builder that silently returns four
 * shots out of forty reads as "there were only four" — which is exactly the kind of quiet cap that
 * makes a tool look like it covered ground it never touched.
 */
export function dropNotes(ride: ShootRide): string[] {
  const counts = new Map<DropReason, number>();
  for (const d of ride.dropped) counts.set(d.reason, (counts.get(d.reason) ?? 0) + 1);
  const order: DropReason[] = ['budget', 'unreachable', 'cap'];
  return order
    .filter((r) => counts.has(r))
    .map((r) => `${counts.get(r)} ${DROP_NOTE[r]}`);
}

export interface ShootRideViewProps {
  ride: ShootRide | null;
  building: boolean;
  /** How many marks the shortlist holds — the denominator for "3 of 40". */
  markCount: number;
  units: Units;
  targetKm: number;
  onTargetKmChange: (km: number) => void;
  loop: boolean;
  onLoopChange: (v: boolean) => void;
  onBuild: () => void;
  onSelectShot: (m: ReelMark) => void;
  /** Opens the whole ride in a maps app. Null while there is no ride to open. */
  mapsHref: string | null;
}

const MIN_RIDE_KM = 10;
const MAX_RIDE_KM = 160;

export function ShootRideView(props: ShootRideViewProps) {
  const { ride, units } = props;
  const t = Math.round(toUnits(props.targetKm, units));
  const dark = ride ? outsideLight(ride.shots) : [];

  return (
    <div className="flex flex-col gap-3">
      <div className="bg-slate-950/50 px-3 py-2.5 rounded-xl border border-slate-800 flex flex-col gap-2">
        <div className="flex items-center justify-between">
          <label htmlFor="reel-ride-km" className="text-[11px] font-bold text-slate-300">
            Ride length
          </label>
          <span className="font-mono text-emerald-400 font-bold text-sm">
            up to {t} {distanceLabel(units)}
          </span>
        </div>
        <input
          id="reel-ride-km"
          type="range"
          className="w-full"
          min={Math.round(toUnits(MIN_RIDE_KM, units))}
          max={Math.round(toUnits(MAX_RIDE_KM, units))}
          value={t}
          aria-label={`Ride length in ${units === 'mi' ? 'miles' : 'kilometers'}`}
          aria-valuetext={`up to ${t} ${units === 'mi' ? 'miles' : 'kilometers'}`}
          onChange={(e) => props.onTargetKmChange(fromUnits(+e.target.value, units))}
        />
        <label className="flex items-center gap-2 min-h-[44px] cursor-pointer">
          <input
            type="checkbox"
            checked={props.loop}
            onChange={(e) => props.onLoopChange(e.target.checked)}
            className="w-4 h-4 accent-emerald-500"
          />
          <span className="text-[11px] font-semibold text-slate-200">Come back to where I started</span>
        </label>
      </div>

      <button
        onClick={props.onBuild}
        disabled={props.building || props.markCount === 0}
        className="min-h-[48px] rounded-xl bg-emerald-500 text-slate-950 text-[13px] font-black disabled:opacity-40 active:scale-[.99] transition-all"
      >
        {props.building ? 'Chaining the shots…' : ride ? 'Build it again' : 'Build the ride'}
      </button>

      {ride && (
        <>
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

          <ol className="flex flex-col gap-1.5">
            {ride.shots.map((s) => (
              <li key={s.mark.id}>
                <button
                  onClick={() => props.onSelectShot(s.mark)}
                  className="w-full text-left px-3 py-2 rounded-xl bg-slate-900/60 border border-slate-800 active:scale-[.99] transition-all flex items-center gap-2.5"
                >
                  <span className="w-6 h-6 shrink-0 grid place-items-center rounded-full bg-emerald-500/15 text-emerald-400 font-mono text-[11px] font-bold">
                    {s.order}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block text-[12px] font-bold text-slate-100 truncate">
                      {s.mark.roadName || 'Unnamed road'}
                    </span>
                    <span className="block text-[10px] text-slate-400 truncate">
                      from {clock(s.at)} · {rideLength(s.km, units)} in
                      {s.light !== 'in' && (
                        <span className="text-amber-400 font-bold">
                          {' '}· {s.light === 'late' ? 'after the light' : 'before the light'}
                        </span>
                      )}
                    </span>
                  </span>
                  <span className="text-slate-500 text-[15px] shrink-0" aria-hidden>›</span>
                </button>
              </li>
            ))}
          </ol>

          {dark.length > 0 && (
            <p className="text-[10px] text-amber-400/90 leading-snug">
              {dark.length === 1 ? 'One shot falls' : `${dark.length} shots fall`} outside the usable
              light at this pace. Arrival times are distance over a steady 45 mph and count no stops,
              so treat them as the earliest you could be there, not the hour you will be.
            </p>
          )}

          {dropNotes(ride).length > 0 && (
            <p className="text-[10px] text-slate-400 leading-snug">
              Not in this ride: {dropNotes(ride).join(', ')}.
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

          <p className="text-[10px] text-slate-400 italic leading-snug">
            The shots keep the scores from their own cards — this orders them for the shortest ride,
            it does not re-score them for the minute you would arrive.
          </p>
        </>
      )}
    </div>
  );
}
