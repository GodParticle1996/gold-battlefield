import { useLayoutEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import { useFrame } from '@react-three/fiber';
import { clamp } from '@gb/shared-config';
import { useStore } from '../store';
import { createBannerGeometry, createSoldierGeometry } from './geometry';
import {
  FRONT_STANDOFF,
  HALF_DEPTH,
  RANK_GAP,
  UNITS_PER_RANK,
  worldX,
} from './world';

export type ArmySide = 'bull' | 'bear';

/** Uniform scale applied to every instance so units read at camera distance. */
const UNIT_SCALE = 1.45;

interface ArmyProps {
  side: ArmySide;
  color: string;
  darkColor: string;
  capacity: number;
  reducedMotion: boolean;
}

/**
 * One InstancedMesh per army (spec §10: never one object per order).
 *
 * The formation is driven imperatively from `useFrame` rather than from React
 * props: the visual state arrives at 12 Hz but units are animated at display
 * rate, and re-rendering hundreds of matrices through React would drop frames.
 * Per-unit scratch data lives in preallocated typed arrays so the hot loop
 * allocates nothing.
 */
export function Army({ side, color, darkColor, capacity, reducedMotion }: ArmyProps) {
  const meshRef = useRef<THREE.InstancedMesh>(null);
  const geometry = useMemo(() => createSoldierGeometry(), []);
  const bannerGeometry = useMemo(() => createBannerGeometry(), []);

  /** -1 → the army stands at lower prices (bids); +1 → higher prices (asks). */
  const dir = side === 'bull' ? -1 : 1;

  const units = useMemo(
    () => ({
      phase: new Float32Array(capacity),
      jitterX: new Float32Array(capacity),
      jitterZ: new Float32Array(capacity),
      surgeBias: new Float32Array(capacity),
      curX: new Float32Array(capacity),
      curZ: new Float32Array(capacity),
      seeded: false,
    }),
    [capacity],
  );

  const scratch = useMemo(
    () => ({
      matrix: new THREE.Matrix4(),
      position: new THREE.Vector3(),
      quaternion: new THREE.Quaternion(),
      scale: new THREE.Vector3(UNIT_SCALE, UNIT_SCALE, UNIT_SCALE),
      color: new THREE.Color(),
      hidden: new THREE.Matrix4().makeScale(0, 0, 0),
    }),
    [],
  );

  // Deterministic per-unit jitter — a formation that reshuffles every frame
  // reads as noise rather than an army.
  useLayoutEffect(() => {
    for (let i = 0; i < capacity; i++) {
      const a = Math.sin(i * 12.9898) * 43758.5453;
      const b = Math.sin(i * 78.233) * 12345.6789;
      const c = Math.sin(i * 39.425) * 24634.6345;
      units.phase[i] = (a - Math.floor(a)) * Math.PI * 2;
      units.jitterX[i] = (b - Math.floor(b) - 0.5) * 0.34;
      units.jitterZ[i] = (c - Math.floor(c) - 0.5) * 0.42;
      units.surgeBias[i] = 0.55 + (a - Math.floor(a)) * 0.45;
    }
    units.seeded = false;
  }, [capacity, units]);

  useLayoutEffect(() => {
    const mesh = meshRef.current;
    if (mesh == null) return;
    // Rear ranks are darker, so depth in the formation is readable at a glance.
    const near = new THREE.Color(color);
    const far = new THREE.Color(darkColor);
    for (let i = 0; i < capacity; i++) {
      const rank = Math.floor(i / UNITS_PER_RANK);
      const depth = clamp(rank / 12, 0, 1);
      scratch.color.copy(near).lerp(far, depth * 0.75);
      mesh.setColorAt(i, scratch.color);
    }
    if (mesh.instanceColor != null) mesh.instanceColor.needsUpdate = true;
  }, [capacity, color, darkColor, scratch]);

  useLayoutEffect(
    () => () => {
      geometry.dispose();
      bannerGeometry.dispose();
    },
    [geometry, bannerGeometry],
  );

  useFrame((_state, delta) => {
    const mesh = meshRef.current;
    if (mesh == null) return;
    const visual = useStore.getState().visual;
    if (visual == null) return;

    const now = Date.now();
    const dt = Math.min(delta, 0.1);
    const front = worldX(visual.priceLineX);
    const strength = side === 'bull' ? visual.bidStrength : visual.askStrength;
    const active = Math.max(8, Math.min(capacity, Math.round(capacity * Math.max(strength, 0.05))));

    // Aggressive buys push the Bull army forward, aggressive sells the Bear army
    // (spec §10). Descriptive of executed flow — not a prediction.
    const flow = side === 'bull' ? visual.momentum : -visual.momentum;
    const aggressor: 'buy' | 'sell' = side === 'bull' ? 'buy' : 'sell';

    let charge = 0;
    for (const effect of visual.effects) {
      if (effect.kind !== 'charge' || effect.side !== aggressor) continue;
      const progress = (now - effect.t0) / effect.lifeMs;
      if (progress < 0 || progress > 1) continue;
      charge = Math.max(charge, Math.sin(progress * Math.PI) * effect.magnitude);
    }
    if (reducedMotion) charge *= 0.35;

    const marchAmp = visual.quiet ? 0.12 : 0.35 + visual.activity * 0.65;
    const time = now / 1000;
    const smooth = 1 - Math.exp(-(reducedMotion ? 4 : 8) * dt);

    // The front widens with the army: a thin book forms a compact squad, a deep
    // book forms a broad host. A fixed rank width made small armies read as a
    // single file receding into the distance.
    const columns = Math.max(6, Math.min(UNITS_PER_RANK, Math.round(Math.sqrt(active * 2.2))));
    const halfFront = HALF_DEPTH * (columns / UNITS_PER_RANK);
    const columnGap = columns > 1 ? (halfFront * 2) / (columns - 1) : 0;

    for (let i = 0; i < capacity; i++) {
      if (i >= active) {
        mesh.setMatrixAt(i, scratch.hidden);
        continue;
      }

      const rank = Math.floor(i / columns);
      const col = i % columns;
      const rankFactor = Math.exp(-rank / 5); // front ranks commit hardest
      const advance = flow * 0.7 + charge * 2.1 * rankFactor * units.surgeBias[i]!;
      const offset = Math.max(0.45, FRONT_STANDOFF + rank * RANK_GAP - advance);

      const targetX = front + dir * offset + units.jitterX[i]!;
      const targetZ = -halfFront + col * columnGap + units.jitterZ[i]!;

      if (!units.seeded) {
        units.curX[i] = targetX;
        units.curZ[i] = targetZ;
      } else {
        units.curX[i]! += (targetX - units.curX[i]!) * smooth;
        units.curZ[i]! += (targetZ - units.curZ[i]!) * smooth;
      }

      const bob = Math.sin(time * 4.2 + units.phase[i]!) * 0.055 * marchAmp;
      scratch.position.set(units.curX[i]!, 0.02 + Math.abs(bob), units.curZ[i]!);
      scratch.quaternion.setFromAxisAngle(
        UP,
        (side === 'bull' ? 0 : Math.PI) + Math.sin(time * 2.1 + units.phase[i]!) * 0.09 * marchAmp,
      );
      scratch.matrix.compose(scratch.position, scratch.quaternion, scratch.scale);
      mesh.setMatrixAt(i, scratch.matrix);
    }

    units.seeded = true;
    mesh.instanceMatrix.needsUpdate = true;
  });

  const bannerZ = [-HALF_DEPTH * 0.72, 0, HALF_DEPTH * 0.72];

  return (
    <group>
      <instancedMesh
        ref={meshRef}
        args={[geometry, undefined as unknown as THREE.Material, capacity]}
        frustumCulled={false}
      >
        <meshStandardMaterial roughness={0.72} metalness={0.08} />
      </instancedMesh>
      <ArmyBanners side={side} color={color} geometry={bannerGeometry} offsets={bannerZ} />
    </group>
  );
}

const UP = new THREE.Vector3(0, 1, 0);

/** Standards planted at the rear of each formation; they track the front line. */
function ArmyBanners({
  side,
  color,
  geometry,
  offsets,
}: {
  side: ArmySide;
  color: string;
  geometry: THREE.BufferGeometry;
  offsets: number[];
}) {
  const groupRef = useRef<THREE.Group>(null);
  const dir = side === 'bull' ? -1 : 1;

  useFrame(() => {
    const group = groupRef.current;
    if (group == null) return;
    const visual = useStore.getState().visual;
    if (visual == null) return;
    const strength = side === 'bull' ? visual.bidStrength : visual.askStrength;
    const ranks = Math.max(2, Math.round((strength * 480) / UNITS_PER_RANK));
    const rear = FRONT_STANDOFF + Math.min(ranks, 14) * RANK_GAP + 1.1;
    group.position.x += (worldX(visual.priceLineX) + dir * rear - group.position.x) * 0.08;
  });

  return (
    <group ref={groupRef} rotation={[0, side === 'bull' ? 0 : Math.PI, 0]}>
      {offsets.map((z) => (
        <mesh key={z} geometry={geometry} position={[0, 0, z]}>
          <meshStandardMaterial color={color} roughness={0.6} emissive={color} emissiveIntensity={0.18} />
        </mesh>
      ))}
    </group>
  );
}
