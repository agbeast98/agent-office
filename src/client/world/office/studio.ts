import * as THREE from 'three';
import { FLOOR, WALL_HEIGHT } from '../../../shared/layout';
import { mergeByMaterial, mesh, roundedBox, toon } from '../toon';
import type { Fixture } from './fixture';
import { PALETTE, box } from './materials';

// Architectural finishes: purely visual, within existing wall and furniture envelopes.
// Seating, navigation, interaction targets and the room's collision model stay in their modules.

/** Cable tray, inset felt work mat and the fine shadow line under an oak desktop. */
export function studioDesktop(width: number, depth: number, height: number): THREE.Group {
  const group = new THREE.Group();
  const dark = toon(PALETTE.deskLeg);
  group.add(mesh(roundedBox(width - 0.12, 0.025, depth - 0.08, 0.04), dark, 0, height - 0.09, 0));
  group.add(mesh(roundedBox(1.18, 0.006, 0.53, 0.04), toon('#6c8074'), 0, height + 0.004, 0.06, false));
  group.add(mesh(roundedBox(0.38, 0.008, 0.065, 0.015), dark, 0, height + 0.006, -depth / 2 + 0.09, false));
  group.add(mesh(box(width - 0.4, 0.065, 0.14), dark, 0, height - 0.16, -depth / 2 + 0.15));
  return mergeByMaterial(group);
}

/** A suspended architectural luminaire: linear over work pods, a halo over the lounge. */
export function studioPendant(cord: number, halo = false): THREE.Group {
  const group = new THREE.Group();
  const metal = toon('#303c3b');
  const glow = toon('#fff1cd', { emissive: '#b69a64' });
  for (const x of [-0.5, 0.5]) group.add(mesh(box(0.014, cord, 0.014), metal, x, cord / 2, 0, false));
  if (halo) {
    const ring = mesh(new THREE.TorusGeometry(0.78, 0.04, 6, 40), metal, 0, 0, 0, false);
    ring.rotation.x = Math.PI / 2;
    group.add(ring);
    const diffuser = mesh(new THREE.TorusGeometry(0.78, 0.02, 6, 40), glow, 0, -0.045, 0, false);
    diffuser.rotation.x = Math.PI / 2;
    group.add(diffuser);
  } else {
    group.add(mesh(roundedBox(1.9, 0.075, 0.14, 0.03), metal, 0, 0, 0, false));
    group.add(mesh(roundedBox(1.8, 0.012, 0.1, 0.02), glow, 0, -0.043, 0, false));
  }
  return mergeByMaterial(group);
}

/** An oak acoustic feature wall defines the lounge without blocking the orbit camera. */
export const studioArchitecture: Fixture = (site) => {
  const group = new THREE.Group();
  const oak = toon('#b59b77');
  const backing = toon('#46564e');
  // Set into the east wall, behind the existing TV: no intrusion into the lounge circulation.
  group.add(mesh(box(0.035, 3.3, 7.6), backing, FLOOR.maxX - 0.02, 2, 0, false));
  for (let i = 0; i < 32; i++) group.add(mesh(box(0.055, 3.3, 0.10), oak, FLOOR.maxX - 0.065, 2, -3.65 + i * 0.235, false));
  // Crisp charcoal cornice: runs above the windows and leaves their openings untouched.
  for (const z of [FLOOR.minZ + 0.03, FLOOR.maxZ - 0.03]) group.add(mesh(box(36, 0.06, 0.06), backing, 0, WALL_HEIGHT - 0.12, z, false));
  site.wall('east', 0, 2, 7.6, 3.3);
  return { group: mergeByMaterial(group) };
};
