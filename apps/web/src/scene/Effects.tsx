import { useLayoutEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import { useFrame } from '@react-three/fiber';
import type { EffectIntensity } from '@gb/shared-config';
import { clamp } from '@gb/shared-config';
import { useStore } from '../store';
import { createDebrisGeometry } from './geometry';
import type { Palette } from './palette';
import { worldX } from './world';

const RING_POOL = 10;
const WEDGE_POOL = 6;

interface EffectsProps {
  palette: Palette;
  intensity: EffectIntensity;
  reducedMotion: boolean;
  particleBudget: number;
}

/**
 * All transient effects run on fixed-size pools that are allocated once and
 * hidden when idle (spec §10/§16). Nothing mounts or unmounts per market event,
 * so a burst of large trades cannot spike GC or draw calls.
 *
 * These are "pressure events" — large executed trades and fortifications
 * leaving the book. They are never liquidations: no spot-gold venue reports
 * those, so the app never renders one (spec §8).
 */
export function Effects({ palette, intensity, reducedMotion, particleBudget }: EffectsProps) {
  if (intensity === 'minimal') {
    return <ImpactRings palette={palette} intensity={intensity} reducedMotion={reducedMotion} />;
  }
  return (
    <group>
      <ImpactRings palette={palette} intensity={intensity} reducedMotion={reducedMotion} />
      <ChargeWedges palette={palette} reducedMotion={reducedMotion} />
      {particleBudget > 0 && (
        <Debris palette={palette} capacity={particleBudget} intensity={intensity} reducedMotion={reducedMotion} />
      )}
    </group>
  );
}

/** Expanding ground rings marking where a large trade printed. */
function ImpactRings({
  palette,
  intensity,
  reducedMotion,
}: {
  palette: Palette;
  intensity: EffectIntensity;
  reducedMotion: boolean;
}) {
  const groupRef = useRef<THREE.Group>(null);
  const meshes = useRef<THREE.Mesh[]>([]);
  const peakOpacity = reducedMotion ? 0.28 : intensity === 'cinematic' ? 0.85 : 0.6;

  useFrame(() => {
    const visual = useStore.getState().visual;
    const pool = meshes.current;
    if (pool.length === 0) return;

    const now = Date.now();
    const rings = (visual?.effects ?? []).filter(
      (effect) => effect.kind === 'impact' || effect.kind === 'wall-break',
    );

    for (let slot = 0; slot < pool.length; slot++) {
      const mesh = pool[slot];
      if (mesh == null) continue;
      const effect = rings[slot];
      if (effect == null) {
        mesh.visible = false;
        continue;
      }
      const progress = clamp((now - effect.t0) / effect.lifeMs, 0, 1);
      const radius = 0.6 + progress * (2.5 + effect.magnitude * 7);
      mesh.visible = true;
      mesh.position.x = worldX(effect.x);
      mesh.scale.set(radius, radius, 1);
      const material = mesh.material as THREE.MeshBasicMaterial;
      material.opacity = (1 - progress) ** 2 * peakOpacity * (0.45 + effect.magnitude * 0.55);
      material.color.set(
        effect.kind === 'wall-break'
          ? palette.front
          : effect.side === 'buy'
            ? palette.bull
            : effect.side === 'sell'
              ? palette.bear
              : palette.front,
      );
    }
  });

  return (
    <group ref={groupRef}>
      {Array.from({ length: RING_POOL }, (_unused, index) => (
        <mesh
          key={index}
          ref={(mesh) => {
            if (mesh != null) meshes.current[index] = mesh;
          }}
          position={[0, 0.08, 0]}
          rotation={[-Math.PI / 2, 0, 0]}
          visible={false}
          renderOrder={2}
        >
          <ringGeometry args={[0.86, 1, 48]} />
          <meshBasicMaterial transparent opacity={0} depthWrite={false} side={THREE.DoubleSide} toneMapped={false} />
        </mesh>
      ))}
    </group>
  );
}

/** An arrowhead of light travelling from the aggressor's side into the front line. */
function ChargeWedges({ palette, reducedMotion }: { palette: Palette; reducedMotion: boolean }) {
  const meshes = useRef<THREE.Mesh[]>([]);

  useFrame(() => {
    const visual = useStore.getState().visual;
    const pool = meshes.current;
    if (pool.length === 0) return;

    const now = Date.now();
    const charges = (visual?.effects ?? []).filter((effect) => effect.kind === 'charge');

    for (let slot = 0; slot < pool.length; slot++) {
      const mesh = pool[slot];
      if (mesh == null) continue;
      const effect = charges[slot];
      if (effect == null || visual == null) {
        if (mesh != null) mesh.visible = false;
        continue;
      }
      const progress = clamp((now - effect.t0) / effect.lifeMs, 0, 1);
      // Buys attack from the bid side (-X) toward the ask side (+X).
      const dir = effect.side === 'buy' ? 1 : -1;
      const target = worldX(effect.x);
      const start = target - dir * 6;
      mesh.visible = true;
      mesh.position.x = start + (target - start) * easeOutCubic(progress);
      mesh.position.z = 0;
      mesh.rotation.z = dir > 0 ? -Math.PI / 2 : Math.PI / 2;
      const size = 0.6 + effect.magnitude * 0.9;
      mesh.scale.set(size, size * 1.6, size);
      const material = mesh.material as THREE.MeshBasicMaterial;
      material.color.set(effect.side === 'buy' ? palette.bull : palette.bear);
      material.opacity = Math.sin(progress * Math.PI) * (reducedMotion ? 0.3 : 0.75);
    }
  });

  return (
    <group>
      {Array.from({ length: WEDGE_POOL }, (_unused, index) => (
        <mesh
          key={index}
          ref={(mesh) => {
            if (mesh != null) meshes.current[index] = mesh;
          }}
          position={[0, 0.9, 0]}
          visible={false}
          renderOrder={3}
        >
          <coneGeometry args={[0.5, 1.4, 4]} />
          <meshBasicMaterial transparent opacity={0} depthWrite={false} toneMapped={false} />
        </mesh>
      ))}
    </group>
  );
}

/**
 * Dust and debris. A fixed instanced pool is recycled round-robin, so the
 * particle count is hard-capped regardless of market activity.
 */
function Debris({
  palette,
  capacity,
  intensity,
  reducedMotion,
}: {
  palette: Palette;
  capacity: number;
  intensity: EffectIntensity;
  reducedMotion: boolean;
}) {
  const meshRef = useRef<THREE.InstancedMesh>(null);
  const geometry = useMemo(() => createDebrisGeometry(), []);
  useLayoutEffect(() => () => geometry.dispose(), [geometry]);

  const state = useMemo(
    () => ({
      px: new Float32Array(capacity),
      py: new Float32Array(capacity),
      pz: new Float32Array(capacity),
      vx: new Float32Array(capacity),
      vy: new Float32Array(capacity),
      vz: new Float32Array(capacity),
      life: new Float32Array(capacity),
      spin: new Float32Array(capacity),
      cursor: 0,
      seen: new Set<number>(),
    }),
    [capacity],
  );

  const scratch = useMemo(
    () => ({
      matrix: new THREE.Matrix4(),
      position: new THREE.Vector3(),
      quaternion: new THREE.Quaternion(),
      scale: new THREE.Vector3(),
      euler: new THREE.Euler(),
      color: new THREE.Color(),
      hidden: new THREE.Matrix4().makeScale(0, 0, 0),
    }),
    [],
  );

  const perBurst = intensity === 'cinematic' ? 26 : 14;

  useFrame((_frameState, delta) => {
    const mesh = meshRef.current;
    if (mesh == null) return;
    const visual = useStore.getState().visual;
    const dt = Math.min(delta, 0.1);
    const now = Date.now();

    // Spawn once per new impact, tracked by effect id.
    for (const effect of visual?.effects ?? []) {
      if (effect.kind === 'charge') continue;
      if (state.seen.has(effect.id)) continue;
      state.seen.add(effect.id);
      if (now - effect.t0 > 400) continue; // too old to be worth a burst

      const count = Math.round(perBurst * (0.4 + effect.magnitude * 0.6) * (reducedMotion ? 0.4 : 1));
      const originX = worldX(effect.x);
      for (let n = 0; n < count; n++) {
        const index = state.cursor;
        state.cursor = (state.cursor + 1) % capacity;
        state.px[index] = originX + (Math.random() - 0.5) * 0.6;
        state.py[index] = 0.15;
        state.pz[index] = (Math.random() - 0.5) * 6;
        const speed = 1.6 + Math.random() * 2.6 * (0.5 + effect.magnitude);
        const angle = Math.random() * Math.PI * 2;
        state.vx[index] = Math.cos(angle) * speed * 0.5;
        state.vy[index] = 1.8 + Math.random() * 2.4;
        state.vz[index] = Math.sin(angle) * speed * 0.5;
        state.life[index] = 1;
        state.spin[index] = (Math.random() - 0.5) * 6;
      }
    }

    // Bounded id memory — effect ids only ever increase.
    if (state.seen.size > 512) state.seen.clear();

    const baseColor = scratch.color.set(palette.trail);
    for (let i = 0; i < capacity; i++) {
      if (state.life[i]! <= 0) {
        mesh.setMatrixAt(i, scratch.hidden);
        continue;
      }
      state.life[i]! -= dt * 0.9;
      state.vy[i]! -= 9.2 * dt;
      state.px[i]! += state.vx[i]! * dt;
      state.py[i]! += state.vy[i]! * dt;
      state.pz[i]! += state.vz[i]! * dt;
      if (state.py[i]! < 0.05) {
        state.py[i] = 0.05;
        state.vy[i]! *= -0.35;
        state.vx[i]! *= 0.6;
        state.vz[i]! *= 0.6;
      }
      const size = clamp(state.life[i]!, 0, 1) * 0.9;
      scratch.position.set(state.px[i]!, state.py[i]!, state.pz[i]!);
      scratch.euler.set(state.life[i]! * state.spin[i]!, state.life[i]! * state.spin[i]! * 0.7, 0);
      scratch.quaternion.setFromEuler(scratch.euler);
      scratch.scale.setScalar(size);
      scratch.matrix.compose(scratch.position, scratch.quaternion, scratch.scale);
      mesh.setMatrixAt(i, scratch.matrix);
      mesh.setColorAt(i, baseColor);
    }
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor != null) mesh.instanceColor.needsUpdate = true;
  });

  return (
    <instancedMesh
      ref={meshRef}
      args={[geometry, undefined as unknown as THREE.Material, capacity]}
      frustumCulled={false}
    >
      <meshStandardMaterial roughness={0.9} metalness={0} />
    </instancedMesh>
  );
}

const easeOutCubic = (t: number): number => 1 - (1 - t) ** 3;
