import { useLayoutEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import { useFrame } from '@react-three/fiber';
import { WALL_DISMANTLE_MS, clamp } from '@gb/shared-config';
import type { Wall } from '@gb/visual-mapping';
import { Label } from './Label';
import { createWallGeometry } from './geometry';
import type { Palette } from './palette';
import { formatUsd, worldX } from './world';

const BUILD_MS = 450;

/**
 * A single fortification. Resting liquidity is *displayed* liquidity: it can be
 * consumed, but it can also simply be cancelled. Both endings are animated as a
 * dismantle — never an explosion — so the visual never implies a trade that did
 * not happen (spec §8/§11).
 */
function Fortification({
  wall,
  geometry,
  palette,
  showLabels,
  reducedMotion,
}: {
  wall: Wall;
  geometry: THREE.BufferGeometry;
  palette: Palette;
  showLabels: boolean;
  reducedMotion: boolean;
}) {
  const groupRef = useRef<THREE.Group>(null);
  const meshRef = useRef<THREE.Mesh>(null);
  const labelRef = useRef<THREE.Group>(null);

  const material = useMemo(
    () =>
      new THREE.MeshStandardMaterial({
        color: wall.side === 'bid' ? palette.bull : palette.bear,
        emissive: wall.side === 'bid' ? palette.bullDark : palette.bearDark,
        emissiveIntensity: 0.5,
        roughness: 0.55,
        metalness: 0.15,
        transparent: true,
        opacity: 1,
      }),
    [wall.side, palette],
  );

  useLayoutEffect(() => () => material.dispose(), [material]);

  const height = 0.65 + wall.strength * 2.4;

  useFrame(() => {
    const group = groupRef.current;
    const mesh = meshRef.current;
    if (group == null || mesh == null) return;
    const now = Date.now();

    group.position.x += (worldX(wall.x) - group.position.x) * 0.2;

    const build = clamp((now - wall.bornAt) / BUILD_MS, 0, 1);
    const rise = 1 - (1 - build) ** 3; // ease-out cubic

    let dismantle = 0;
    if (wall.leftAt != null) dismantle = clamp((now - wall.leftAt) / WALL_DISMANTLE_MS, 0, 1);

    const breathe = reducedMotion || wall.leftAt != null ? 1 : 1 + Math.sin(now / 420) * 0.02;
    const remaining = 1 - dismantle;

    mesh.scale.set(
      (0.75 + wall.strength * 0.5) * (wall.phase === 'overrun' ? remaining : 1),
      height * rise * breathe * remaining,
      0.8 + wall.strength * 0.35,
    );
    // Overrun walls topple away from the side that broke through; withdrawn
    // walls simply sink and fade, because nothing hit them.
    mesh.rotation.z = wall.phase === 'overrun' ? dismantle * (wall.side === 'bid' ? 0.9 : -0.9) : 0;
    mesh.position.y = -dismantle * 0.5;
    material.opacity = remaining;

    if (labelRef.current != null) {
      labelRef.current.position.y = height * rise + 0.75 - dismantle * 0.6;
      labelRef.current.visible = remaining > 0.35;
    }
  });

  return (
    <group ref={groupRef} position={[worldX(wall.x), 0, 0]}>
      <mesh ref={meshRef} geometry={geometry} material={material} castShadow={false} />
      {showLabels && (
        <group ref={labelRef}>
          <Label
            text={`${formatUsd(wall.notional)} @ ${wall.price.toFixed(2)}`}
            style={wall.side === 'bid' ? 'wallBid' : 'wallAsk'}
            position={[0, 0, 0]}
            size={0.5}
          />
        </group>
      )}
    </group>
  );
}

export function Fortifications({
  walls,
  palette,
  showLabels,
  reducedMotion,
}: {
  walls: Wall[];
  palette: Palette;
  showLabels: boolean;
  reducedMotion: boolean;
}) {
  const geometry = useMemo(() => createWallGeometry(), []);
  useLayoutEffect(() => () => geometry.dispose(), [geometry]);

  return (
    <group>
      {walls.map((wall) => (
        // Keyed by the mapper's stable wall id, so a fortification is never
        // remounted just because the price ladder shifted underneath it.
        <Fortification
          key={wall.id}
          wall={wall}
          geometry={geometry}
          palette={palette}
          showLabels={showLabels}
          reducedMotion={reducedMotion}
        />
      ))}
    </group>
  );
}
