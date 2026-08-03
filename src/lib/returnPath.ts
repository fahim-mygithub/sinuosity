import { pathLength, type LatLng } from './geometry';
import type { ScannedRoad } from '../data/types';

/**
 * Connector-graph routing for loop rides' "way back to the start".
 *
 * A linear standout road (e.g. Zoar Valley Rd) can't be circled using only the curvy *candidate*
 * roads — closing the loop needs the plain connector roads too. So this module works over the FULL
 * scanned corpus (every secondary/tertiary/unclassified way in the radius), building an undirected
 * endpoint graph and finding the shortest alternate path from the ride's far end back to its start,
 * EXCLUDING the ride's own ways so the return is genuinely a different road home.
 *
 * The geometry stays 2D and the graph is memoized per corpus array, so repeated builds (a bias
 * slider nudge) don't rebuild it.
 */

/** Node key: OSM ways split at junctions share the junction node exactly; rounding to 4 dp (~11 m)
 *  matches routeBuilder's endpoint index so a ride endpoint hashes to the same node. */
const round4 = (n: number) => n.toFixed(4);
const nodeKey = (p: LatLng) => `${round4(p[0])},${round4(p[1])}`;

interface Edge {
  to: string;
  wayId: string;
  /** Polyline oriented FROM this node TO `to`. */
  coords: LatLng[];
  km: number;
}

export interface ReturnGraph {
  adj: Map<string, Edge[]>;
}

/**
 * Do two points hash to the same graph node — i.e. are they the same junction?
 *
 * Exported because "these two roads already meet, so there is no connector to route" is a real and
 * common case when chaining shots, and it is NOT the same answer as {@link findReturnPath} returning
 * null. That returns null for both "already here" and "no way through", and a caller that conflates
 * them drops a perfectly good adjoining road as unreachable. Comparing keys rather than metres keeps
 * the question the graph's own — a caller inventing its own tolerance would disagree with the graph
 * at exactly the distances that matter.
 */
export function sameNode(a: LatLng, b: LatLng): boolean {
  return nodeKey(a) === nodeKey(b);
}

const graphCache = new WeakMap<ScannedRoad[], ReturnGraph>();

/** Memoized {@link buildReturnGraph} keyed by the corpus array identity. */
export function getReturnGraph(roads: ScannedRoad[]): ReturnGraph {
  const cached = graphCache.get(roads);
  if (cached) return cached;
  const g = buildReturnGraph(roads);
  graphCache.set(roads, g);
  return g;
}

/**
 * Undirected junction graph over a road corpus, NODED AT SHARED VERTICES.
 *
 * A way is split wherever it touches another way, not merely at its two ends, and each piece becomes
 * an edge in both directions with its polyline oriented away from each end.
 *
 * SPLITTING ONLY AT ENDPOINTS IS WHAT THIS REPLACES, and it did not work. Road networks connect at
 * T-junctions — a side road meets the MIDDLE of a through road — and the tile corpus stores roads as
 * merged same-name corridors, which buries junction vertices deeper still. Joining ways only where
 * an end met an end therefore linked almost nothing: measured on the real 30 km Ellicottville corpus
 * (684 ways), the endpoint-only graph had 978 nodes in **298 disconnected components**, the largest
 * holding 18 nodes and 185 of them being an isolated pair. Over a graph like that Dijkstra answers
 * "no route" between essentially any two roads, which silently defeated every caller: loop rides
 * fell back to a retrace rather than a circuit, and chaining shots into a ride found nothing
 * reachable at all.
 *
 * A vertex becomes a node when two DIFFERENT ways share it, or when it is a way's own end. That is
 * the standard noding rule and it is deliberately geometric rather than topological: OSM ways that
 * genuinely cross without meeting (a bridge over a road) do not share a vertex, so they do not get
 * an edge, which is the correct answer for a rider.
 *
 * Sub-edges keep their PARENT way's id, so `excludeWayIds` still excludes a whole road rather than
 * the one piece of it a route happened to touch.
 */
export function buildReturnGraph(roads: ScannedRoad[]): ReturnGraph {
  // Pass one: which vertices are junctions? A vertex shared by two different ways is one; so is
  // either end of a way, which is what keeps a dead-end road attached to the network at its mouth.
  const firstOwner = new Map<string, string>();
  const isNode = new Set<string>();
  for (const r of roads) {
    const c = r.coords;
    if (!c || c.length < 2) continue;
    isNode.add(nodeKey(c[0]));
    isNode.add(nodeKey(c[c.length - 1]));
    for (const p of c) {
      const k = nodeKey(p);
      const owner = firstOwner.get(k);
      if (owner === undefined) firstOwner.set(k, r.id);
      else if (owner !== r.id) isNode.add(k);
    }
  }

  // Pass two: cut each way at its junctions and lay both directions of every piece.
  const adj = new Map<string, Edge[]>();
  const push = (k: string, e: Edge) => {
    const list = adj.get(k);
    if (list) list.push(e);
    else adj.set(k, [e]);
  };
  for (const r of roads) {
    const c = r.coords;
    if (!c || c.length < 2) continue;
    let from = 0;
    for (let i = 1; i < c.length; i++) {
      // The final vertex is an end, so it is always a node and the last piece always closes.
      if (!isNode.has(nodeKey(c[i]))) continue;
      const seg = c.slice(from, i + 1);
      from = i;
      const a = nodeKey(seg[0]);
      const b = nodeKey(seg[seg.length - 1]);
      if (a === b) continue; // a piece that returns to its own junction connects nothing
      const km = pathLength(seg);
      if (!(km > 0)) continue;
      push(a, { to: b, wayId: r.id, coords: seg, km });
      push(b, { to: a, wayId: r.id, coords: [...seg].reverse(), km });
    }
  }
  return { adj };
}

/**
 * Which parts of the network can reach which. Nodes, grouped into connected components.
 *
 * Exported because a scanned corpus is NOT one connected network and treating it as one produces
 * silent nonsense. Measured on the real 30 km Ellicottville corpus the junction graph holds 129
 * components over 996 nodes, the largest covering only a quarter of them — the corpus carries
 * secondary, tertiary and unclassified ways but not the residential streets that knit them together,
 * so what is scanned is genuinely a set of islands. A caller that picks a start point by distance
 * alone will land on an island with nothing on it, and every route it then asks for fails.
 *
 * Memoized per graph, which is itself memoized per corpus array, so this costs one pass per scan.
 */
export interface Components {
  /** Component id of the node a point hashes to, or null when the graph has no node there. */
  of(p: LatLng): number | null;
  /** How many nodes that component holds. */
  size(id: number): number;
  /** Every node in a component. */
  nodes(id: number): LatLng[];
}

const componentCache = new WeakMap<ReturnGraph, Components>();

export function connectedComponents(graph: ReturnGraph): Components {
  const cached = componentCache.get(graph);
  if (cached) return cached;

  const idOf = new Map<string, number>();
  const members: string[][] = [];
  for (const seed of graph.adj.keys()) {
    if (idOf.has(seed)) continue;
    const id = members.length;
    const group: string[] = [];
    const stack = [seed];
    idOf.set(seed, id);
    while (stack.length) {
      const u = stack.pop()!;
      group.push(u);
      for (const e of graph.adj.get(u) ?? []) {
        if (idOf.has(e.to)) continue;
        idOf.set(e.to, id);
        stack.push(e.to);
      }
    }
    members.push(group);
  }

  const toPoint = (k: string): LatLng => {
    const c = k.indexOf(',');
    return [Number(k.slice(0, c)), Number(k.slice(c + 1))];
  };
  const out: Components = {
    of: (p) => idOf.get(nodeKey(p)) ?? null,
    size: (id) => members[id]?.length ?? 0,
    nodes: (id) => (members[id] ?? []).map(toPoint),
  };
  componentCache.set(graph, out);
  return out;
}

export interface FindReturnOpts {
  /** Way ids to avoid — the featured ride's own ways, so the return is a different road home. */
  excludeWayIds?: Set<string>;
  /** Reject a return longer than this (km). */
  maxKm?: number;
  /** Safety cap on settled nodes. */
  maxNodes?: number;
}

/** Settled state of one Dijkstra run, enough to reconstruct a path to any settled node. */
interface Explored {
  dist: Map<string, number>;
  prev: Map<string, { from: string; coords: LatLng[] }>;
  done: Set<string>;
}

/**
 * Bounded Dijkstra from one source, stopping once every node in `targets` is settled (or the
 * budget runs out). Lazy-deletion via a binary heap.
 *
 * Multi-target because chaining N shots into a ride needs the distance from each shot's exit to
 * every other shot's entry — an N x N matrix. Running one search per PAIR would be N² searches over
 * a corpus of thousands of ways; one search per SOURCE settles a whole row at once, which is N. The
 * single-target case is just the row with one entry in it, so there is one implementation rather
 * than two that can drift.
 */
function explore(
  graph: ReturnGraph,
  source: string,
  targets: Set<string>,
  exclude: Set<string>,
  maxKm: number,
  maxNodes: number,
): Explored {
  const dist = new Map<string, number>([[source, 0]]);
  const prev = new Map<string, { from: string; coords: LatLng[] }>();
  const done = new Set<string>();
  const heap = new MinHeap();
  heap.push(source, 0);
  let settled = 0;
  let wanted = 0;
  for (const t of targets) if (t !== source) wanted++;

  while (heap.size() > 0) {
    const top = heap.pop()!;
    const u = top.key;
    if (done.has(u)) continue;
    done.add(u);
    if (u !== source && targets.has(u) && --wanted <= 0) break;
    if (++settled > maxNodes) break;
    const du = top.dist;
    for (const e of graph.adj.get(u) ?? []) {
      if (exclude.has(e.wayId)) continue;
      const nd = du + e.km;
      if (nd > maxKm) continue;
      if (nd < (dist.get(e.to) ?? Infinity)) {
        dist.set(e.to, nd);
        prev.set(e.to, { from: u, coords: e.coords });
        heap.push(e.to, nd);
      }
    }
  }
  return { dist, prev, done };
}

/** Stitch the oriented edges from `source` to `target` into one polyline in travel order. */
function reconstruct(ex: Explored, source: string, target: string, maxKm: number): LatLng[] | null {
  if (!ex.done.has(target) || (ex.dist.get(target) ?? Infinity) > maxKm) return null;

  // Walk target → source collecting oriented edges, then flip to source → target travel order.
  const edges: LatLng[][] = [];
  let cur = target;
  while (cur !== source) {
    const p = ex.prev.get(cur);
    if (!p) return null;
    edges.push(p.coords); // oriented p.from → cur
    cur = p.from;
  }
  edges.reverse();

  const out: LatLng[] = [];
  for (const seg of edges) {
    if (out.length === 0) out.push(...seg);
    else out.push(...seg.slice(1)); // drop the shared junction vertex
  }
  return out.length >= 2 ? out : null;
}

/**
 * Shortest alternate path from `fromPt`'s node to `toPt`'s node over the connector graph, avoiding
 * `excludeWayIds`. Returns the stitched polyline oriented `fromPt → toPt`, or `null` when there is
 * no path within `maxKm` (the caller then retraces the fun road instead).
 */
export function findReturnPath(
  graph: ReturnGraph,
  fromPt: LatLng,
  toPt: LatLng,
  opts: FindReturnOpts = {},
): LatLng[] | null {
  const source = nodeKey(fromPt);
  const target = nodeKey(toPt);
  if (source === target) return null;
  if (!graph.adj.has(source) || !graph.adj.has(target)) return null;
  const maxKm = opts.maxKm ?? Infinity;
  const ex = explore(
    graph,
    source,
    new Set([target]),
    opts.excludeWayIds ?? new Set<string>(),
    maxKm,
    opts.maxNodes ?? 60000,
  );
  return reconstruct(ex, source, target, maxKm);
}

/**
 * One row of the distance matrix: shortest paths from `fromPt` to EACH of `toPts`, in the same
 * order, `null` where there is no path within budget.
 *
 * A target equal to the source yields `null`, matching {@link findReturnPath} — "route to where you
 * already are" is not a leg, and a caller stitching legs head-to-tail would otherwise splice a
 * one-point polyline into the ride.
 */
export function findPathsFrom(
  graph: ReturnGraph,
  fromPt: LatLng,
  toPts: LatLng[],
  opts: FindReturnOpts = {},
): (LatLng[] | null)[] {
  const source = nodeKey(fromPt);
  const keys = toPts.map(nodeKey);
  if (!graph.adj.has(source)) return toPts.map(() => null);
  const maxKm = opts.maxKm ?? Infinity;
  const wanted = new Set(keys.filter((k) => k !== source && graph.adj.has(k)));
  if (wanted.size === 0) return toPts.map(() => null);
  const ex = explore(
    graph,
    source,
    wanted,
    opts.excludeWayIds ?? new Set<string>(),
    maxKm,
    opts.maxNodes ?? 60000,
  );
  return keys.map((k) => (k === source || !graph.adj.has(k) ? null : reconstruct(ex, source, k, maxKm)));
}

/** Minimal binary min-heap of (key, dist). Supports duplicate pushes (lazy decrease-key). */
class MinHeap {
  private keys: string[] = [];
  private dists: number[] = [];

  size(): number {
    return this.keys.length;
  }

  push(key: string, dist: number): void {
    this.keys.push(key);
    this.dists.push(dist);
    let i = this.keys.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (this.dists[parent] <= this.dists[i]) break;
      this.swap(i, parent);
      i = parent;
    }
  }

  pop(): { key: string; dist: number } | null {
    if (this.keys.length === 0) return null;
    const key = this.keys[0];
    const dist = this.dists[0];
    const lastKey = this.keys.pop()!;
    const lastDist = this.dists.pop()!;
    if (this.keys.length > 0) {
      this.keys[0] = lastKey;
      this.dists[0] = lastDist;
      let i = 0;
      const n = this.keys.length;
      for (;;) {
        const l = 2 * i + 1;
        const r = 2 * i + 2;
        let smallest = i;
        if (l < n && this.dists[l] < this.dists[smallest]) smallest = l;
        if (r < n && this.dists[r] < this.dists[smallest]) smallest = r;
        if (smallest === i) break;
        this.swap(i, smallest);
        i = smallest;
      }
    }
    return { key, dist };
  }

  private swap(a: number, b: number): void {
    [this.keys[a], this.keys[b]] = [this.keys[b], this.keys[a]];
    [this.dists[a], this.dists[b]] = [this.dists[b], this.dists[a]];
  }
}
