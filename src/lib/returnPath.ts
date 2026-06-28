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

const graphCache = new WeakMap<ScannedRoad[], ReturnGraph>();

/** Memoized {@link buildReturnGraph} keyed by the corpus array identity. */
export function getReturnGraph(roads: ScannedRoad[]): ReturnGraph {
  const cached = graphCache.get(roads);
  if (cached) return cached;
  const g = buildReturnGraph(roads);
  graphCache.set(roads, g);
  return g;
}

/** Undirected endpoint graph over a road corpus: each way contributes an edge in both directions,
 *  with the polyline oriented away from each endpoint. */
export function buildReturnGraph(roads: ScannedRoad[]): ReturnGraph {
  const adj = new Map<string, Edge[]>();
  const push = (k: string, e: Edge) => {
    const list = adj.get(k);
    if (list) list.push(e);
    else adj.set(k, [e]);
  };
  for (const r of roads) {
    const c = r.coords;
    if (!c || c.length < 2) continue;
    const a = nodeKey(c[0]);
    const b = nodeKey(c[c.length - 1]);
    if (a === b) continue; // a ring is no use as a connector between two distinct nodes
    const km = pathLength(c);
    if (!(km > 0)) continue;
    push(a, { to: b, wayId: r.id, coords: c, km });
    push(b, { to: a, wayId: r.id, coords: [...c].reverse(), km });
  }
  return { adj };
}

export interface FindReturnOpts {
  /** Way ids to avoid — the featured ride's own ways, so the return is a different road home. */
  excludeWayIds?: Set<string>;
  /** Reject a return longer than this (km). */
  maxKm?: number;
  /** Safety cap on settled nodes. */
  maxNodes?: number;
}

/**
 * Shortest alternate path from `fromPt`'s node to `toPt`'s node over the connector graph, avoiding
 * `excludeWayIds`. Returns the stitched polyline oriented `fromPt → toPt`, or `null` when there is
 * no path within `maxKm` (the caller then retraces the fun road instead). Bounded Dijkstra with
 * lazy-deletion via a binary heap.
 */
export function findReturnPath(
  graph: ReturnGraph,
  fromPt: LatLng,
  toPt: LatLng,
  opts: FindReturnOpts = {},
): LatLng[] | null {
  const exclude = opts.excludeWayIds ?? new Set<string>();
  const maxKm = opts.maxKm ?? Infinity;
  const maxNodes = opts.maxNodes ?? 60000;
  const source = nodeKey(fromPt);
  const target = nodeKey(toPt);
  if (source === target) return null;
  if (!graph.adj.has(source) || !graph.adj.has(target)) return null;

  const dist = new Map<string, number>([[source, 0]]);
  const prev = new Map<string, { from: string; coords: LatLng[] }>();
  const done = new Set<string>();
  const heap = new MinHeap();
  heap.push(source, 0);
  let settled = 0;

  while (heap.size() > 0) {
    const top = heap.pop()!;
    const u = top.key;
    if (done.has(u)) continue;
    done.add(u);
    if (u === target) break;
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

  if (!done.has(target) || (dist.get(target) ?? Infinity) > maxKm) return null;

  // Walk target → source collecting oriented edges, then flip to source → target travel order.
  const edges: LatLng[][] = [];
  let cur = target;
  while (cur !== source) {
    const p = prev.get(cur);
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
