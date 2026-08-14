import { useLayoutEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import type { PriceTick } from '@gb/visual-mapping';
import { Label } from './Label';
import type { Palette } from './palette';
import { FIELD_DEPTH, HALF_DEPTH, HALF_WIDTH, worldX } from './world';

const TRAIL_CAPACITY = 120;

/** Terrain bands: one strip per price tick, brighter on the labelled majors. */
function PriceBands({ ticks, palette, showLabels }: { ticks: PriceTick[]; palette: Palette; showLabels: boolean }) {
  const bandGeometry = useMemo(() => new THREE.BoxGeometry(0.05, 0.02, FIELD_DEPTH), []);
  const minorMaterial = useMemo(
    () => new THREE.MeshBasicMaterial({ color: palette.groundBand, transparent: true, opacity: 0.55 }),
    [palette.groundBand],
  );
  const majorMaterial = useMemo(
    () => new THREE.MeshBasicMaterial({ color: palette.groundBandMajor }),
    [palette.groundBandMajor],
  );

  useLayoutEffect(
    () => () => {
      bandGeometry.dispose();
      minorMaterial.dispose();
      majorMaterial.dispose();
    },
    [bandGeometry, minorMaterial, majorMaterial],
  );

  return (
    <group>
      {ticks.map((tick) => (
        <group key={tick.price} position={[worldX(tick.x), 0, 0]}>
          <mesh geometry={bandGeometry} material={tick.major ? majorMaterial : minorMaterial} position={[0, 0.01, 0]} />
          {showLabels && tick.major && (
            <Label
              text={tick.price.toFixed(2)}
              style="tick"
              position={[0, 0.35, HALF_DEPTH + 1.1]}
              size={0.55}
              renderOrder={5}
            />
          )}
        </group>
      ))}
    </group>
  );
}

/**
 * The scar the front line leaves behind: one faded marker per recent price
 * sample, oldest darkest. Instanced so a long history costs a single draw call.
 */
function PriceTrail({ trail, palette }: { trail: number[]; palette: Palette }) {
  const ref = useRef<THREE.InstancedMesh>(null);
  const scratch = useMemo(() => ({ matrix: new THREE.Matrix4(), color: new THREE.Color() }), []);
  const trailColor = useMemo(() => new THREE.Color(palette.trail), [palette.trail]);

  useLayoutEffect(() => {
    const mesh = ref.current;
    if (mesh == null) return;
    const count = Math.min(trail.length, TRAIL_CAPACITY);
    for (let i = 0; i < TRAIL_CAPACITY; i++) {
      if (i >= count) {
        scratch.matrix.makeScale(0, 0, 0);
        mesh.setMatrixAt(i, scratch.matrix);
        continue;
      }
      // Index 0 is the oldest sample, so age fades from the start of the array.
      const age = 1 - i / Math.max(1, count - 1);
      scratch.matrix.makeTranslation(worldX(trail[i]!), 0.015, 0);
      mesh.setMatrixAt(i, scratch.matrix);
      scratch.color.copy(trailColor).multiplyScalar(0.15 + (1 - age) * 0.85);
      mesh.setColorAt(i, scratch.color);
    }
    mesh.count = TRAIL_CAPACITY;
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor != null) mesh.instanceColor.needsUpdate = true;
  }, [trail, scratch, trailColor]);

  return (
    <instancedMesh
      ref={ref}
      args={[undefined as unknown as THREE.BufferGeometry, undefined as unknown as THREE.Material, TRAIL_CAPACITY]}
      frustumCulled={false}
      renderOrder={1}
    >
      {/* A short central band: a full-depth strip reads as a rail across the
          field rather than as scarred ground behind the front line. */}
      <boxGeometry args={[0.1, 0.012, FIELD_DEPTH * 0.34]} />
      <meshBasicMaterial transparent opacity={0.3} />
    </instancedMesh>
  );
}

export function Terrain({
  ticks,
  trail,
  palette,
  showLabels,
}: {
  ticks: PriceTick[];
  trail: number[];
  palette: Palette;
  showLabels: boolean;
}) {
  return (
    <group>
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0, 0]} receiveShadow={false}>
        <planeGeometry args={[HALF_WIDTH * 2 + 12, FIELD_DEPTH + 8]} />
        <meshStandardMaterial color={palette.ground} roughness={1} metalness={0} />
      </mesh>
      <PriceBands ticks={ticks} palette={palette} showLabels={showLabels} />
      <PriceTrail trail={trail} palette={palette} />
    </group>
  );
}
