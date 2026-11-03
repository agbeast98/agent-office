import * as THREE from 'three';
import { mergeByColor, mesh, roundedBox, toon } from '../toon';

/** One compact, easy-to-read gaming chair, shared by every desk that uses the same accent. */
const chairs = new Map<string, THREE.Group>();

export function chair(color: string): THREE.Group {
  const accentColor = `#${new THREE.Color(color).getHexString()}`;
  const cached = chairs.get(accentColor);
  if (cached) return cached.clone(true);

  const source = new THREE.Group();
  const frame = toon('#303842');
  const cushion = toon('#4a535d');
  const accent = toon(accentColor);
  const steel = toon('#818d92');
  const rubber = toon('#252d33');

  const addBox = (w: number, h: number, d: number, mat: THREE.Material, x: number, y: number, z: number, radius = 0) => {
    const geometry = radius ? roundedBox(w, h, d, radius) : new THREE.BoxGeometry(w, h, d);
    source.add(mesh(geometry, mat, x, y, z));
  };

  // Five short, matching spokes. Reuse one low-poly shape before the whole chair is merged.
  const spoke = roundedBox(0.065, 0.055, 0.43, 0.022);
  for (let i = 0; i < 5; i++) {
    const angle = (i / 5) * Math.PI * 2;
    const part = mesh(spoke, steel, Math.sin(angle) * 0.22, 0.075, Math.cos(angle) * 0.22);
    part.rotation.y = angle;
    source.add(part);
  }

  // A simple gas lift and compact hub keep the base visually connected to the seat.
  source.add(mesh(new THREE.CylinderGeometry(0.045, 0.055, 0.34, 8), steel, 0, 0.31, 0));
  source.add(mesh(new THREE.CylinderGeometry(0.13, 0.15, 0.085, 8), frame, 0, 0.49, 0));

  // Small horizontal rollers, rotated to sit across their respective spokes.
  const roller = new THREE.CylinderGeometry(0.052, 0.052, 0.075, 8);
  for (let i = 0; i < 5; i++) {
    const angle = (i / 5) * Math.PI * 2;
    const wheel = mesh(roller, rubber, Math.sin(angle) * 0.405, 0.052, Math.cos(angle) * 0.405);
    wheel.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), new THREE.Vector3(Math.cos(angle), 0, -Math.sin(angle)));
    source.add(wheel);
  }

  // Broad seat: one solid pan and one cushion, with no layered side pieces to drift out of place.
  addBox(0.70, 0.12, 0.62, frame, 0, 0.51, 0, 0.07);
  addBox(0.60, 0.15, 0.54, cushion, 0, 0.60, -0.012, 0.065);

  // A single tall back and inset pad make the silhouette clear from across the room.
  addBox(0.66, 0.78, 0.11, frame, 0, 1.06, 0.29, 0.075);
  addBox(0.53, 0.63, 0.045, cushion, 0, 1.055, 0.205, 0.055);
  for (const side of [-1, 1]) addBox(0.035, 0.46, 0.022, accent, side * 0.265, 1.055, 0.174, 0.01);

  // Two short supports and plain padded arms, kept symmetric around the seat.
  for (const side of [-1, 1]) {
    addBox(0.065, 0.22, 0.075, frame, side * 0.36, 0.69, 0.015, 0.018);
    addBox(0.13, 0.075, 0.32, frame, side * 0.36, 0.835, 0, 0.035);
  }

  // Bake the fixed parts into a single vertex-colored mesh. This keeps the accent color while
  // reducing dozens of independently rendered objects to one draw call per chair design.
  const merged = mergeByColor(source);
  const geometries = new Set<THREE.BufferGeometry>();
  source.traverse((object) => {
    const part = object as THREE.Mesh;
    if (part.isMesh) geometries.add(part.geometry);
  });
  for (const geometry of geometries) geometry.dispose();

  chairs.set(accentColor, merged);
  return merged.clone(true);
}
