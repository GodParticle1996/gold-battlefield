import { useEffect, useRef } from 'react';
import * as THREE from 'three';
import { useFrame, useThree } from '@react-three/fiber';
import { OrbitControls } from '@react-three/drei';
import type { CameraMode } from '@gb/shared-config';
import { useStore } from '../store';
import { CAMERA_HOME, CAMERA_ISO, HALF_WIDTH, worldX } from './world';

interface ControlsLike {
  target: THREE.Vector3;
  update: () => void;
}

const HOME_POSITION = new THREE.Vector3(...CAMERA_HOME);
const ISO_POSITION = new THREE.Vector3(...CAMERA_ISO);
const PAN_SPEED = 18; // world units per second

export function CameraRig({
  mode,
  resetSignal,
  reducedMotion,
  tvMode,
}: {
  mode: CameraMode;
  resetSignal: number;
  reducedMotion: boolean;
  tvMode: boolean;
}) {
  const { camera } = useThree();
  const controls = useThree((state) => state.controls) as unknown as ControlsLike | null;
  const keys = useRef(new Set<string>());

  useEffect(() => {
    if (mode !== 'fixed-iso') return;
    camera.position.copy(ISO_POSITION);
    camera.lookAt(0, 0, 0);
    controls?.target.set(0, 0, 0);
    controls?.update();
  }, [mode, camera, controls]);

  useEffect(() => {
    if (resetSignal === 0) return;
    camera.position.copy(HOME_POSITION);
    camera.lookAt(0, 0, 0);
    controls?.target.set(0, 0, 0);
    controls?.update();
  }, [resetSignal, camera, controls]);

  // Keyboard panning (spec §12). Ignored while typing in a form control.
  useEffect(() => {
    const isTypingTarget = (target: EventTarget | null): boolean =>
      target instanceof HTMLElement &&
      (target.tagName === 'INPUT' || target.tagName === 'SELECT' || target.isContentEditable);

    const down = (event: KeyboardEvent): void => {
      if (isTypingTarget(event.target)) return;
      keys.current.add(event.key.toLowerCase());
    };
    const up = (event: KeyboardEvent): void => {
      keys.current.delete(event.key.toLowerCase());
    };
    const blur = (): void => keys.current.clear();

    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    window.addEventListener('blur', blur);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
      window.removeEventListener('blur', blur);
    };
  }, []);

  useFrame((_state, delta) => {
    if (controls == null) return;
    const dt = Math.min(delta, 0.1);

    const pressed = keys.current;
    let dx = 0;
    let dz = 0;
    if (pressed.has('a') || pressed.has('arrowleft')) dx -= 1;
    if (pressed.has('d') || pressed.has('arrowright')) dx += 1;
    if (pressed.has('w') || pressed.has('arrowup')) dz -= 1;
    if (pressed.has('s') || pressed.has('arrowdown')) dz += 1;

    if (dx !== 0 || dz !== 0) {
      const step = PAN_SPEED * dt;
      controls.target.x = THREE.MathUtils.clamp(controls.target.x + dx * step, -HALF_WIDTH, HALF_WIDTH);
      controls.target.z = THREE.MathUtils.clamp(controls.target.z + dz * step, -HALF_WIDTH, HALF_WIDTH);
      camera.position.x += dx * step;
      camera.position.z += dz * step;
      controls.update();
      return;
    }

    if (mode === 'follow-price') {
      const visual = useStore.getState().visual;
      if (visual != null) {
        const targetX = worldX(visual.priceLineX);
        controls.target.x += (targetX - controls.target.x) * (reducedMotion ? 0.03 : 0.07);
        controls.update();
      }
    }
  });

  if (mode === 'fixed-iso') return null;

  return (
    <OrbitControls
      makeDefault
      enableDamping={!reducedMotion}
      dampingFactor={0.1}
      autoRotate={tvMode && !reducedMotion}
      autoRotateSpeed={0.28}
      minDistance={8}
      maxDistance={70}
      maxPolarAngle={Math.PI / 2.15}
    />
  );
}

/**
 * Camera shake, applied to the world instead of the camera so it never fights
 * OrbitControls. Disabled entirely under reduced motion (spec §11).
 */
export function ShakeGroup({
  enabled,
  children,
}: {
  enabled: boolean;
  children: React.ReactNode;
}) {
  const groupRef = useRef<THREE.Group>(null);
  const energy = useRef(0);
  const seen = useRef(new Set<number>());

  useFrame((_state, delta) => {
    const group = groupRef.current;
    if (group == null) return;
    if (!enabled) {
      group.position.set(0, 0, 0);
      return;
    }

    const visual = useStore.getState().visual;
    const now = Date.now();
    for (const effect of visual?.effects ?? []) {
      if (effect.kind === 'charge') continue;
      if (seen.current.has(effect.id)) continue;
      seen.current.add(effect.id);
      if (now - effect.t0 > 300) continue;
      if (effect.magnitude > 0.8) energy.current = Math.min(1, energy.current + effect.magnitude * 0.5);
    }
    if (seen.current.size > 512) seen.current.clear();

    energy.current = Math.max(0, energy.current - delta * 2.2);
    const amplitude = energy.current * 0.22;
    group.position.set(
      (Math.random() - 0.5) * amplitude,
      (Math.random() - 0.5) * amplitude * 0.5,
      (Math.random() - 0.5) * amplitude,
    );
  });

  return <group ref={groupRef}>{children}</group>;
}
