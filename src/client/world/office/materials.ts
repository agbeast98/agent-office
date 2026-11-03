import * as THREE from 'three';
import { FLOOR, WALL_T, type Side } from '../../../shared/layout';
import { FLOOR_PALETTES, type FloorPalette } from '../../../shared/floors';
import { mesh } from '../toon';

// What the office is painted and glazed with, the planks of its floors, and where on an outside wall a
// window or a door goes.

export const PALETTE = {
  floor: FLOOR_PALETTES[0].floor,
  floorAlt: FLOOR_PALETTES[0].floorAlt,
  wall: FLOOR_PALETTES[0].wall,
  wallTrim: FLOOR_PALETTES[0].trim,
  desk: '#ded0b6',
  deskLeg: '#303c3b',
  wood: '#b99266',
  cork: '#d8a86a',
  chairs: ['#668279', '#627d89', '#9b906f', '#797a8b', '#bc9462', '#789b91'],
  rugs: ['#a8b4a4', '#c1b5a0', '#94aaa6', '#b5b4aa'],
  plant: '#63876a',
  plantDark: '#355c48',
  pot: '#b7b0a1',
  ink: '#2b2d42',
  /** The building's outside paint. */
  exterior: '#c7c6b8',
};

/** Window glass: faintly blue and see-through. */
export const GLASS = new THREE.MeshBasicMaterial({ color: '#d6f1ff', transparent: true, opacity: 0.09, depthWrite: false, side: THREE.DoubleSide });
const SHINE = new THREE.MeshBasicMaterial({ color: '#ffffff', transparent: true, opacity: 0.12, depthWrite: false, side: THREE.DoubleSide });

/** A sheet of glass `w` by `h`, centered, with a couple of cartoon glints so it reads as glass. */
export function glassPane(w: number, h: number): THREE.Group {
  const g = new THREE.Group();
  g.add(mesh(new THREE.PlaneGeometry(w, h), GLASS, 0, 0, 0, false));
  // Each streak is a slanted strip trimmed to the pane, so on a narrow pane its ends stop at the
  // frame instead of running out over it.
  const edgeX = w / 2 - 0.02;
  const edgeY = h / 2 - 0.02;
  for (const [gx, gw] of [
    [-w * 0.2, 0.18],
    [-w * 0.2 + 0.32, 0.08],
  ]) {
    const outline = clipToBox(slantedStrip(gx, h * 0.07, gw, h * 0.55, -0.5), edgeX, edgeY);
    if (outline.length < 3) continue;
    const glint = mesh(new THREE.ShapeGeometry(new THREE.Shape(outline)), SHINE, 0, 0, 0.01, false);
    g.add(glint);
  }
  return g;
}

/** The corners of a `w` by `len` strip centered on (x, y), turned `angle` radians. */
function slantedStrip(x: number, y: number, w: number, len: number, angle: number): THREE.Vector2[] {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  return [
    [-w / 2, -len / 2],
    [w / 2, -len / 2],
    [w / 2, len / 2],
    [-w / 2, len / 2],
  ].map(([u, v]) => new THREE.Vector2(x + u * c - v * s, y + u * s + v * c));
}

/** A convex outline cut down to the box from (-ex, -ey) to (ex, ey) (Sutherland–Hodgman). */
function clipToBox(points: THREE.Vector2[], ex: number, ey: number): THREE.Vector2[] {
  const edges: ((p: THREE.Vector2) => number)[] = [(p) => ex - p.x, (p) => p.x + ex, (p) => ey - p.y, (p) => p.y + ey];
  let out = points;
  for (const inside of edges) {
    const next: THREE.Vector2[] = [];
    out.forEach((p, i) => {
      const q = out[(i + 1) % out.length];
      const dp = inside(p);
      const dq = inside(q);
      if (dp >= 0) next.push(p);
      if (dp >= 0 !== dq >= 0) next.push(p.clone().lerp(q, dp / (dp - dq)));
    });
    out = next;
    if (out.length < 3) return [];
  }
  return out;
}

/** The middle of an outside wall at `u` along it, and the turn that makes local +z point outdoors. */
export function onWall(side: Side, u: number): { x: number; z: number; rotY: number } {
  switch (side) {
    case 'north':
      return { x: u, z: FLOOR.minZ - WALL_T / 2, rotY: Math.PI };
    case 'south':
      return { x: u, z: FLOOR.maxZ + WALL_T / 2, rotY: 0 };
    case 'west':
      return { x: FLOOR.minX - WALL_T / 2, z: u, rotY: -Math.PI / 2 };
    case 'east':
      return { x: FLOOR.maxX + WALL_T / 2, z: u, rotY: Math.PI / 2 };
  }
}

/** Restrained architectural paint, with each team's original hue retained as a subtle tint. */
export function studioPalette(p: FloorPalette): FloorPalette {
  const tint = (a: string, b: string, amount: number) => `#${new THREE.Color(a).lerp(new THREE.Color(b), amount).getHexString()}`;
  return { ...p, wall: tint(p.wall, '#eeeae1', 0.72), trim: tint(p.trim, '#525f58', 0.72), floor: tint(p.floor, '#cdbb9f', 0.8), floorAlt: tint(p.floorAlt, '#c3af91', 0.8), seam: '#9d8d76' };
}

/** Fine-grained oak planks in a floor's colors. */
export function paintPlanks(c: HTMLCanvasElement, p: FloorPalette) {
  p = studioPalette(p);
  const g = c.getContext('2d')!;
  g.fillStyle = p.floor;
  g.fillRect(0, 0, 512, 512);
  for (let row = 0; row < 8; row++) {
    const offset = (row % 2) * 128;
    for (let col = -1; col < 3; col++) {
      const x = col * 256 + offset;
      g.fillStyle = (row + col) % 3 === 0 ? p.floorAlt : p.floor;
      g.fillRect(x + 1, row * 64 + 1, 254, 63);
    }
    // Deterministic fine grain: no downloaded texture or random flicker when teams change.
    g.globalAlpha = 0.08;
    g.fillStyle = '#5b4833';
    for (let line = 0; line < 7; line++) g.fillRect((row * 47 + line * 31) % 110, row * 64 + 6 + line * 8, 220 + line * 23, 1);
    g.globalAlpha = 1;
    g.fillStyle = p.seam;
    g.fillRect(0, row * 64, 512, 1);
  }
}

export function floorTexture(width = FLOOR.maxX - FLOOR.minX, depth = FLOOR.maxZ - FLOOR.minZ): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 512;
  c.height = 512;
  paintPlanks(c, FLOOR_PALETTES[0]);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(width / 6, depth / 6);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}

export function box(w: number, h: number, d: number) {
  return new THREE.BoxGeometry(w, h, d);
}

/** The materials and textures a floor paints in its own colors. */
export interface Looks {
  wall: THREE.MeshToonMaterial;
  trim: THREE.MeshToonMaterial;
  planks: THREE.CanvasTexture[];
}
