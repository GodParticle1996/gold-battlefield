import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

/**
 * Procedural low-poly geometry. The repository ships no 3D asset files, so
 * every mesh is generated here and merged into a single BufferGeometry per
 * unit type — one geometry is what makes InstancedMesh possible (spec §10:
 * never one object per order).
 */

/**
 * Merges parts into one geometry, disposing the inputs.
 *
 * three's primitives are not consistently indexed — Box/Cylinder are, the
 * polyhedra (Icosahedron/Tetrahedron) are not — and `mergeGeometries` rejects a
 * mixed set. Everything is converted to non-indexed first so any combination of
 * primitives can be composed.
 */
function merge(parts: THREE.BufferGeometry[], name: string): THREE.BufferGeometry {
  const flattened = parts.map((part) => (part.index == null ? part : part.toNonIndexed()));
  const merged = mergeGeometries(flattened, false);

  for (const part of parts) part.dispose();
  for (let i = 0; i < flattened.length; i++) {
    if (flattened[i] !== parts[i]) flattened[i]!.dispose();
  }

  if (merged == null) throw new Error(`failed to merge ${name} geometry`);
  merged.computeVertexNormals();
  return merged;
}

/**
 * A ~56-triangle infantry figure: tapered body, faceted head, and a shield
 * carried on the enemy-facing side. Built once and shared by both armies.
 */
export function createSoldierGeometry(): THREE.BufferGeometry {
  const body = new THREE.CylinderGeometry(0.11, 0.17, 0.4, 6, 1);
  body.translate(0, 0.2, 0);

  const head = new THREE.IcosahedronGeometry(0.095, 0);
  head.translate(0, 0.47, 0);

  // Helmet crest — a tiny wedge that gives the silhouette a direction.
  const crest = new THREE.BoxGeometry(0.16, 0.05, 0.04);
  crest.translate(0, 0.55, 0);

  // Shield faces +X; the army's root rotation aims it at the front line.
  const shield = new THREE.BoxGeometry(0.04, 0.22, 0.2);
  shield.translate(0.14, 0.24, 0);

  return merge([body, head, crest, shield], 'soldier');
}

/**
 * A crenellated fortification block: a slab with four merlons on top, so a
 * wall reads as a defensive structure rather than a bar chart.
 */
export function createWallGeometry(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];

  const slab = new THREE.BoxGeometry(0.5, 1, 3.4);
  slab.translate(0, 0.5, 0);
  parts.push(slab);

  for (let i = 0; i < 4; i++) {
    const merlon = new THREE.BoxGeometry(0.5, 0.22, 0.5);
    merlon.translate(0, 1.11, -1.28 + i * 0.85);
    parts.push(merlon);
  }

  return merge(parts, 'wall');
}

/** Banner pole + flag, used as the army standard behind each formation. */
export function createBannerGeometry(): THREE.BufferGeometry {
  const pole = new THREE.CylinderGeometry(0.035, 0.035, 2.2, 5);
  pole.translate(0, 1.1, 0);

  const flag = new THREE.BoxGeometry(0.03, 0.5, 0.9);
  flag.translate(0, 1.85, 0.45);

  return merge([pole, flag], 'banner');
}

/** Small angular chunk used for dust and debris particles. */
export function createDebrisGeometry(): THREE.BufferGeometry {
  return new THREE.TetrahedronGeometry(0.11, 0);
}
