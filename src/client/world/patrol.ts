import * as THREE from 'three';
import { deskPoint, type NavGrid, type Pt } from '../../shared/nav';
import type { DeskDef } from '../../shared/layout';
import type { Worker } from './character';

/*
 * The security agents walking about the floor. A security agent doesn't sit at a desk: it wanders the office
 * on its own, now and then stopping to look about, and when something it guards needs it (a hold to decide,
 * see server/security.ts) it walks over and stands beside that agent's desk, facing it, until it is decided,
 * then goes back to wandering. Its desk stays its own but empty.
 */

/** Walking pace (m/s), before its age slows it down; seconds it stands about between walks, and how far each wander goes at least. */
const WALK = 1.9;
const PAUSE: [number, number] = [2.5, 7];
const MIN_WANDER = 4;
/** A worker's feet are this far above its origin (see features/workers/leaving.ts). */
const FEET = 0.07;
/** How far it stands from the desk it is with, out to the side of its chair. */
const BESIDE = 1.15;

interface Walker {
  model: Worker;
  /** On its feet and going somewhere, or standing (about, or at its post). */
  state: 'walk' | 'stand';
  way: Pt[];
  next: number;
  /** Seconds of standing about left before it wanders off again. */
  rest: number;
  /** The desk it is with, or none: it's wandering; and where that desk's worker is, to face it. */
  post?: DeskDef;
  look?: () => Pt | undefined;
  heading: number;
  stepIn: number;
}

const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));
const between = ([a, b]: [number, number]) => a + Math.random() * (b - a);

export class Patrol {
  private walkers = new Map<string, Walker>();

  constructor(
    private parent: THREE.Object3D,
    private nav: () => NavGrid,
    /** The top of whatever is underfoot at (x, z) for feet at `y`. */
    private ground: (x: number, z: number, y: number) => number,
    private footstep: (x: number, y: number, z: number) => void,
  ) {}

  has(id: string) {
    return this.walkers.has(id);
  }

  /** Puts `model` on its feet where it is (out of its seat), to wander. */
  add(id: string, model: Worker, at: Pt) {
    if (this.walkers.has(id)) return;
    this.parent.add(model.root);
    model.root.position.set(at[0], this.ground(at[0], at[1], 2) - FEET, at[1]);
    model.root.rotation.set(0, 0, 0);
    model.root.scale.setScalar(1);
    this.walkers.set(id, { model, state: 'stand', way: [], next: 0, rest: between([0.5, 3]), heading: 0, stepIn: 0 });
  }

  /** Stops walking `id` about; its model is left wherever it is. */
  remove(id: string) {
    const w = this.walkers.get(id);
    if (!w) return;
    w.model.walking = false;
    w.model.gait = 1;
    this.walkers.delete(id);
  }

  /** Where `id` is now, for what needs to know. */
  where(id: string): Pt | undefined {
    const w = this.walkers.get(id);
    return w && [w.model.root.position.x, w.model.root.position.z];
  }

  /** Whether `id` has got to the desk it was sent to. */
  atPost(id: string): boolean {
    const w = this.walkers.get(id);
    return !!w?.post && w.state === 'stand';
  }

  /** Sends `id` to stand beside `desk`'s worker, or (no desk) back to wandering. */
  setPost(id: string, desk: DeskDef | undefined, look?: () => Pt | undefined) {
    const w = this.walkers.get(id);
    if (!w) return;
    w.look = look;
    if (w.post?.id === desk?.id) return;
    w.post = desk;
    if (!desk) {
      w.rest = 0.3;
      if (w.state === 'stand') return;
    }
    const here: Pt = [w.model.root.position.x, w.model.root.position.z];
    const to = desk ? this.spotBeside(desk, here) : this.wanderPoint(here);
    this.goTo(w, to);
  }

  /** Beside the chair, on whichever side is nearer to `from`. */
  private spotBeside(desk: DeskDef, from: Pt): Pt {
    const sides = [BESIDE, -BESIDE].map((t) => deskPoint(desk, t, 0.7));
    const nav = this.nav();
    const ok = sides.filter((p) => nav.walkable(p[0], p[1]));
    const pick = (ok.length ? ok : sides).sort((a, b) => Math.hypot(a[0] - from[0], a[1] - from[1]) - Math.hypot(b[0] - from[0], b[1] - from[1]))[0];
    return ok.length ? pick : nav.nearestWalkable(pick);
  }

  /** Somewhere else on the floor to wander to. */
  private wanderPoint(from: Pt): Pt {
    const nav = this.nav();
    const { minX, maxX, minZ, maxZ } = nav.bounds;
    for (let i = 0; i < 40; i++) {
      const p: Pt = [minX + 1 + Math.random() * (maxX - minX - 2), minZ + 1 + Math.random() * (maxZ - minZ - 2)];
      if (nav.walkable(p[0], p[1]) && Math.hypot(p[0] - from[0], p[1] - from[1]) > MIN_WANDER) return p;
    }
    return from;
  }

  private goTo(w: Walker, to: Pt) {
    const p = w.model.root.position;
    w.way = this.nav().route([p.x, p.z], to);
    w.next = 1;
    w.state = 'walk';
  }

  update(dt: number) {
    for (const w of this.walkers.values()) this.step(w, dt);
  }

  private step(w: Walker, dt: number) {
    const { root } = w.model;
    const pos = root.position;
    if (w.state === 'walk') {
      let move = WALK * w.model.pace * dt;
      while (move > 0 && w.next < w.way.length) {
        const [x, z] = w.way[w.next];
        const dx = x - pos.x;
        const dz = z - pos.z;
        const d = Math.hypot(dx, dz);
        if (d > 1e-4) w.heading = Math.atan2(dx, dz);
        if (d <= move) {
          pos.x = x;
          pos.z = z;
          move -= d;
          w.next++;
        } else {
          pos.x += (dx / d) * move;
          pos.z += (dz / d) * move;
          move = 0;
        }
      }
      w.model.walking = w.next < w.way.length;
      if (w.model.walking) {
        w.stepIn -= dt;
        if (w.stepIn <= 0) {
          w.stepIn += Math.PI / (9 * w.model.pace);
          this.footstep(pos.x, pos.y, pos.z);
        }
      } else {
        w.state = 'stand';
        w.rest = between(PAUSE);
      }
    } else {
      w.model.walking = false;
      // Wandering: after a pause it picks somewhere else. With a desk to be at, it just stands there.
      if (!w.post) {
        w.rest -= dt;
        if (w.rest <= 0) this.goTo(w, this.wanderPoint([pos.x, pos.z]));
      }
    }
    pos.y += (this.ground(pos.x, pos.z, pos.y + FEET + 0.35) - FEET - pos.y) * Math.min(1, dt * 14);
    // Facing the way it walks; at its post, toward the desk's worker.
    const at = w.state === 'stand' && w.post ? (w.look?.() ?? [w.post.x, w.post.z]) : undefined;
    const face = at ? Math.atan2(at[0] - pos.x, at[1] - pos.z) : w.heading;
    root.rotation.set(0, root.rotation.y + wrap(face - root.rotation.y) * Math.min(1, dt * 8), 0);
  }
}
