import * as THREE from 'three';
import { FLOOR } from '../../../shared/layout';
import { mergeByMaterial, mesh, roundedBox, textPlane, toon } from '../toon';
import type { Fixture } from './fixture';
import { box } from './materials';
import { deskBooks, deskMug, plant } from './props';

/** Restrained wayfinding and everyday details, all inside existing walls and furniture footprints. */
export const studioZones: Fixture = (site) => {
  const group = new THREE.Group();
  const finish = toon('#43554b');
  const brass = toon('#b49a72');
  // Small wayfinding plaque beside the entrance, clear of the exit and every window.
  const entry = new THREE.Group();
  entry.add(mesh(roundedBox(1.9, 0.05, 0.8, 0.06), finish));
  entry.children[0].rotation.x = Math.PI / 2;
  const entryLabel = textPlane('فضای کار تیمی', { color: '#f1eadd', size: 48 });
  entryLabel.scale.setScalar(0.64);
  entryLabel.position.z = 0.035;
  entry.add(entryLabel);
  entry.position.set(FLOOR.minX + 0.075, 1.9, 9.15);
  entry.rotation.y = Math.PI / 2;
  group.add(entry);
  site.wall('west', 9.15, 1.9, 1.9, 0.8);

  // Kitchen sign on the solid pier above the fridge, between the south windows.
  const cafe = textPlane('کافه دفتر', { color: '#43554b', size: 52 });
  cafe.scale.setScalar(0.82);
  cafe.position.set(-11.5, 2.95, FLOOR.maxZ - 0.06);
  cafe.rotation.y = Math.PI;
  group.add(cafe);
  const underline = mesh(box(1.35, 0.025, 0.035), brass, -11.5, 2.67, FLOOR.maxZ - 0.055, false);
  group.add(underline);
  site.wall('south', -11.5, 2.9, 1.8, 0.65);

  // A serving tray and cups on the existing counter, away from the espresso machine and sink.
  const tray = mesh(roundedBox(0.58, 0.025, 0.34, 0.06), finish, -12.55, 1.05, 12.13);
  group.add(tray);
  for (const x of [-12.7, -12.42]) {
    const mug = deskMug('#ebe7dc');
    mug.position.set(x, 1.065, 12.13);
    group.add(mug);
  }

  // Low tabletop details leave the middle clear for seasonal decorations.
  const books = deskBooks(2);
  books.position.set(13.4, 0.46, -0.3);
  books.rotation.y = 0.3;
  group.add(books);
  const succulent = plant('succulent', 0.75);
  succulent.position.set(12.6, 0.46, 0.25);
  group.add(succulent);
  // Merge only the static primitive details; imported model pieces retain their own materials/UVs.
  const details = new THREE.Group();
  details.add(underline, tray);
  group.add(mergeByMaterial(details));
  return { group };
};
