import { useRef } from 'react';
import * as THREE from 'three';
import { useFrame } from '@react-three/fiber';
import { useStore } from '../store';
import { Label } from './Label';
import type { Palette } from './palette';
import { FIELD_DEPTH, HALF_DEPTH, worldX } from './world';

/**
 * The contested price. Position is interpolated inside `useFrame` so the line
 * glides at display rate even though market state arrives at 12 Hz.
 */
export function FrontLine({ palette, reducedMotion }: { palette: Palette; reducedMotion: boolean }) {
  const groupRef = useRef<THREE.Group>(null);
  const glowRef = useRef<THREE.Mesh>(null);

  useFrame(() => {
    const group = groupRef.current;
    if (group == null) return;
    const visual = useStore.getState().visual;
    if (visual == null) return;

    const target = worldX(visual.priceLineX);
    group.position.x += (target - group.position.x) * (reducedMotion ? 0.08 : 0.16);

    if (glowRef.current != null) {
      const pulse = reducedMotion ? 1 : 1 + Math.sin(Date.now() / 300) * 0.12 * (0.3 + visual.activity);
      glowRef.current.scale.set(pulse, 1, 1);
    }
  });

  return (
    <group ref={groupRef}>
      <mesh position={[0, 0.05, 0]}>
        <boxGeometry args={[0.13, 0.1, FIELD_DEPTH]} />
        <meshStandardMaterial
          color={palette.front}
          emissive={palette.front}
          emissiveIntensity={1.1}
          toneMapped={false}
        />
      </mesh>
      <mesh ref={glowRef} position={[0, 1.6, 0]}>
        <boxGeometry args={[0.05, 3.2, FIELD_DEPTH * 0.98]} />
        <meshBasicMaterial color={palette.front} transparent opacity={0.13} depthWrite={false} />
      </mesh>
      <PriceTag palette={palette} />
    </group>
  );
}

/** Subscribes to the price alone, so the front line's mesh never re-renders. */
function PriceTag({ palette }: { palette: Palette }) {
  const showLabels = useStore((state) => state.showLabels);
  const price = useStore((state) => state.visual?.lastPrice ?? null);
  const source = useStore((state) => state.visual?.priceSource ?? null);
  if (!showLabels || price == null) return null;
  // The tag never claims a stale print is the current price.
  const text = `$${price.toFixed(2)}${source === 'midpoint' ? ' mid' : ''}`;
  return (
    <group>
      <Label text={text} style="price" position={[0, 4.3, 0]} size={1.05} />
      <mesh position={[0, 3.5, 0]}>
        <coneGeometry args={[0.22, 0.5, 4]} />
        <meshBasicMaterial color={palette.front} toneMapped={false} />
      </mesh>
    </group>
  );
}

/**
 * The no-man's-land between best bid and best ask. Nothing trades inside it —
 * making the spread a literal gap is the clearest way to show what it is.
 */
export function SpreadZone({ palette, showLabels }: { palette: Palette; showLabels: boolean }) {
  const meshRef = useRef<THREE.Mesh>(null);
  const groupRef = useRef<THREE.Group>(null);

  useFrame(() => {
    const mesh = meshRef.current;
    const group = groupRef.current;
    if (mesh == null || group == null) return;
    const visual = useStore.getState().visual;
    if (visual == null || visual.bestBidX == null || visual.bestAskX == null) {
      group.visible = false;
      return;
    }
    group.visible = true;
    const bid = worldX(visual.bestBidX);
    const ask = worldX(visual.bestAskX);
    // A crossed or zero-width book must still render something visible.
    const width = Math.max(0.08, ask - bid);
    group.position.x += ((bid + ask) / 2 - group.position.x) * 0.2;
    mesh.scale.x = width;
  });

  return (
    <group ref={groupRef}>
      <mesh ref={meshRef} position={[0, 0.3, 0]}>
        <boxGeometry args={[1, 0.6, FIELD_DEPTH * 0.99]} />
        <meshBasicMaterial color={palette.front} transparent opacity={0.08} depthWrite={false} />
      </mesh>
      {showLabels && <BestMarkers palette={palette} />}
    </group>
  );
}

/** BID / ASK posts at the near edge of the field. */
function BestMarkers({ palette }: { palette: Palette }) {
  const bidRef = useRef<THREE.Group>(null);
  const askRef = useRef<THREE.Group>(null);

  useFrame(() => {
    const visual = useStore.getState().visual;
    if (visual == null) return;
    const centre = (worldX(visual.bestBidX ?? 0) + worldX(visual.bestAskX ?? 0)) / 2;
    if (bidRef.current != null && visual.bestBidX != null) {
      bidRef.current.position.x = worldX(visual.bestBidX) - centre;
    }
    if (askRef.current != null && visual.bestAskX != null) {
      askRef.current.position.x = worldX(visual.bestAskX) - centre;
    }
  });

  // The spread is usually a cent wide, so the two posts sit almost on top of
  // each other; the labels are staggered in height to stay readable.
  return (
    <group position={[0, 0, HALF_DEPTH - 0.6]}>
      <group ref={bidRef}>
        <mesh position={[0, 0.45, 0]}>
          <boxGeometry args={[0.1, 0.9, 0.1]} />
          <meshStandardMaterial color={palette.bull} emissive={palette.bull} emissiveIntensity={0.6} />
        </mesh>
        <Label text="BID" style="army" position={[-0.5, 1.15, 0]} size={0.4} />
      </group>
      <group ref={askRef}>
        <mesh position={[0, 0.45, 0]}>
          <boxGeometry args={[0.1, 0.9, 0.1]} />
          <meshStandardMaterial color={palette.bear} emissive={palette.bear} emissiveIntensity={0.6} />
        </mesh>
        <Label text="ASK" style="army" position={[0.5, 1.85, 0]} size={0.4} />
      </group>
    </group>
  );
}
