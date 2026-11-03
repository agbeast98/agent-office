import * as THREE from 'three';
import { mesh, roundedBox, toon } from '../toon';

/** A compact, upholstered racing chair, built from Three.js shapes to match the office's toon world. */
export function chair(color: string): THREE.Group {
  const group = new THREE.Group();
  const shell = toon('#252a38');
  const shellLight = toon('#353b4c');
  const cushion = toon('#424858');
  const accent = toon(color);
  const seam = toon('#f4f0e8');
  const metal = toon('#8d99ae');
  const rubber = toon('#202431');

  const add = (geometry: THREE.BufferGeometry, material: THREE.Material, x = 0, y = 0, z = 0, rz = 0) => {
    const part = mesh(geometry, material, x, y, z);
    part.rotation.z = rz;
    group.add(part);
    return part;
  };
  const pad = (w: number, h: number, d: number, r: number, mat: THREE.Material, x: number, y: number, z: number, rz = 0) =>
    add(roundedBox(w, h, d, r), mat, x, y, z, rz);
  const softPad = (w: number, h: number, d: number, mat: THREE.Material, x: number, y: number, z: number) => {
    const part = mesh(new THREE.SphereGeometry(1, 16, 12), mat, x, y, z);
    part.scale.set(w / 2, h / 2, d / 2);
    group.add(part);
    return part;
  };

  // A five-spoke rolling base and gas lift give the chair a recognisable office-chair silhouette.
  add(new THREE.CylinderGeometry(0.052, 0.052, 0.38, 12), metal, 0, 0.27, 0);
  add(new THREE.CylinderGeometry(0.13, 0.16, 0.08, 12), rubber, 0, 0.47, 0);
  for (let i = 0; i < 5; i++) {
    const angle = (i / 5) * Math.PI * 2;
    const spoke = mesh(roundedBox(0.075, 0.055, 0.42, 0.035), metal);
    spoke.position.set(Math.sin(angle) * 0.22, 0.055, Math.cos(angle) * 0.22);
    spoke.rotation.y = angle;
    group.add(spoke);
    const wheel = mesh(new THREE.SphereGeometry(0.052, 10, 8), rubber, Math.sin(angle) * 0.39, 0.045, Math.cos(angle) * 0.39);
    wheel.scale.set(1, 0.78, 0.72);
    group.add(wheel);
  }

  // Seat pan, padded center, and raised side bolsters.
  pad(0.7, 0.12, 0.62, 0.12, shell, 0, 0.51, 0);
  softPad(0.56, 0.16, 0.53, cushion, 0, 0.6, -0.015);
  for (const side of [-1, 1]) {
    pad(0.14, 0.13, 0.51, 0.065, shellLight, side * 0.27, 0.61, 0.015, side * -0.08);
    pad(0.035, 0.035, 0.37, 0.016, accent, side * 0.283, 0.679, -0.015);
  }
  pad(0.38, 0.026, 0.025, 0.012, accent, 0, 0.681, -0.27);

  // The tall back is a layered shell with padded shoulder wings, a headrest, and lumbar cushion.
  pad(0.64, 0.82, 0.12, 0.15, rubber, 0, 1.005, 0.29);
  // Rear shell detailing keeps the racing-chair silhouette readable from across the office.
  pad(0.45, 0.64, 0.028, 0.12, shellLight, 0, 1.0, 0.363);
  for (const side of [-1, 1]) {
    pad(0.035, 0.58, 0.03, 0.016, accent, side * 0.25, 1.0, 0.382);
    pad(0.17, 0.045, 0.028, 0.018, accent, side * 0.105, 1.235, 0.385, side * -0.3);
  }
  pad(0.24, 0.045, 0.028, 0.018, accent, 0, 0.77, 0.382);
  pad(0.53, 0.68, 0.045, 0.12, shellLight, 0, 1.0, 0.207);
  pad(0.4, 0.53, 0.035, 0.1, cushion, 0, 0.99, 0.176);
  for (const side of [-1, 1]) {
    pad(0.13, 0.38, 0.12, 0.06, shell, side * 0.245, 1.05, 0.19, side * -0.12);
    pad(0.035, 0.28, 0.026, 0.012, accent, side * 0.285, 1.05, 0.126, side * -0.12);
    // Small openings in the shoulder area, picked out in the dark shell.
    pad(0.085, 0.065, 0.025, 0.025, rubber, side * 0.12, 1.295, 0.142);
  }
  pad(0.4, 0.17, 0.13, 0.075, shell, 0, 1.38, 0.205);
  softPad(0.3, 0.11, 0.05, accent, 0, 1.38, 0.116);
  pad(0.38, 0.16, 0.12, 0.07, shell, 0, 0.82, 0.145);
  softPad(0.3, 0.09, 0.05, cushion, 0, 0.82, 0.073);
  pad(0.23, 0.022, 0.02, 0.009, seam, 0, 1.12, 0.135);

  // Padded armrests on sturdy supports, kept inside the desk footprint.
  for (const side of [-1, 1]) {
    add(new THREE.CylinderGeometry(0.026, 0.033, 0.24, 8), metal, side * 0.37, 0.69, 0.01);
    pad(0.13, 0.075, 0.34, 0.045, shell, side * 0.37, 0.83, 0.0);
    pad(0.075, 0.026, 0.22, 0.013, accent, side * 0.37, 0.881, -0.01);
  }

  return group;
}
