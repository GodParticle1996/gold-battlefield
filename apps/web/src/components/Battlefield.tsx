import { memo, useRef } from 'react';
import * as THREE from 'three';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import type { QualityLevel } from '@gb/shared-config';
import { QUALITY_LEVELS } from '@gb/shared-config';
import { useStore } from '../store';
import { Army } from '../scene/Army';
import { CameraRig, ShakeGroup } from '../scene/CameraRig';
import { Effects } from '../scene/Effects';
import { FrontLine, SpreadZone } from '../scene/FrontLine';
import { Fortifications } from '../scene/Fortifications';
import { Label } from '../scene/Label';
import { Terrain } from '../scene/Terrain';
import { paletteFor, type Palette } from '../scene/palette';
import { useThrottled } from '../scene/useThrottled';
import {
  CAMERA_HOME,
  FRONT_STANDOFF,
  HALF_DEPTH,
  QUALITY_DPR,
  QUALITY_PARTICLES,
  QUALITY_UNITS,
  RANK_GAP,
  UNITS_PER_RANK,
  formatUsd,
  worldX,
} from '../scene/world';

const MemoArmy = memo(Army);
const MemoEffects = memo(Effects);

const stepQuality = (quality: QualityLevel, dir: 1 | -1): QualityLevel => {
  const index = QUALITY_LEVELS.indexOf(quality);
  const next = Math.min(QUALITY_LEVELS.length - 1, Math.max(0, index + dir));
  return QUALITY_LEVELS[next]!;
};

/**
 * Samples FPS/frame time/draw calls every 2 s, publishes them to the store, and
 * auto-adjusts the quality level with hysteresis when auto-quality is on.
 */
function PerformanceProbe() {
  const setPerf = useStore((state) => state.setPerf);
  const quality = useStore((state) => state.quality);
  const autoQuality = useStore((state) => state.autoQuality);
  const setQuality = useStore((state) => state.setQuality);
  const gl = useThree((state) => state.gl);
  const frames = useRef(0);
  const lastSample = useRef(performance.now());
  const lowSamples = useRef(0);
  const highSamples = useRef(0);

  useFrame(() => {
    frames.current += 1;
    const now = performance.now();
    const elapsed = now - lastSample.current;
    if (elapsed < 2000) return;

    const fps = (frames.current * 1000) / elapsed;
    const visual = useStore.getState().visual;
    const capacity = QUALITY_UNITS[quality];
    const activeUnits =
      Math.max(8, Math.round(capacity * Math.max(visual?.bidStrength ?? 0, 0.05))) +
      Math.max(8, Math.round(capacity * Math.max(visual?.askStrength ?? 0, 0.05)));

    setPerf({
      fps: Math.round(fps),
      frameMs: Math.round((elapsed / frames.current) * 10) / 10,
      drawCalls: gl.info.render.calls,
      activeUnits,
    });
    frames.current = 0;
    lastSample.current = now;

    if (!autoQuality) return;
    if (fps < 40) {
      lowSamples.current += 1;
      highSamples.current = 0;
    } else if (fps > 55) {
      highSamples.current += 1;
      lowSamples.current = 0;
    } else {
      lowSamples.current = 0;
      highSamples.current = 0;
    }
    if (lowSamples.current >= 2 && quality !== 'battery-saver') {
      setQuality(stepQuality(quality, -1));
      lowSamples.current = 0;
    } else if (highSamples.current >= 3 && quality !== 'high') {
      setQuality(stepQuality(quality, 1));
      highSamples.current = 0;
    }
  });

  return null;
}

/** Standard planted behind each formation, naming the side and its resting depth. */
function ArmyStandard({ side, palette }: { side: 'bull' | 'bear'; palette: Palette }) {
  const groupRef = useRef<THREE.Group>(null);
  const depth = useStore((state) =>
    side === 'bull' ? state.metrics?.bidDepthNotional : state.metrics?.askDepthNotional,
  );
  const text = useThrottled(
    `${side === 'bull' ? 'BULLS' : 'BEARS'} · ${depth == null || depth === 0 ? 'no depth' : formatUsd(depth)}`,
    1_000,
  );
  const dir = side === 'bull' ? -1 : 1;

  useFrame(() => {
    const group = groupRef.current;
    if (group == null) return;
    const visual = useStore.getState().visual;
    if (visual == null) return;
    const strength = side === 'bull' ? visual.bidStrength : visual.askStrength;
    const ranks = Math.min(14, Math.max(2, Math.round((strength * 480) / UNITS_PER_RANK)));
    const rear = FRONT_STANDOFF + ranks * RANK_GAP + 2.4;
    group.position.x += (worldX(visual.priceLineX) + dir * rear - group.position.x) * 0.08;
  });

  return (
    <group ref={groupRef}>
      <Label text={text} style="army" position={[0, 2.9, -HALF_DEPTH * 0.35]} size={0.7} />
      <mesh position={[0, 0.02, 0]} rotation={[-Math.PI / 2, 0, 0]}>
        <circleGeometry args={[0.9, 24]} />
        <meshBasicMaterial
          color={side === 'bull' ? palette.bull : palette.bear}
          transparent
          opacity={0.12}
        />
      </mesh>
    </group>
  );
}

/** Honest idle state: when nothing trades, the field says so instead of faking a battle. */
function QuietBanner() {
  const quiet = useStore((state) => state.visual?.quiet ?? false);
  const since = useStore((state) => state.visual?.msSinceLastTrade ?? null);
  const text = useThrottled(
    since == null ? 'FRONT QUIET · no trades yet' : `FRONT QUIET · no trades for ${Math.round(since / 1000)}s`,
    1_000,
  );
  if (!quiet) return null;
  // Above the price tag (4.3) and the army standards (2.9) so nothing collides.
  return <Label text={text} style="army" position={[0, 8.2, 0]} size={0.8} />;
}

function BattlefieldInner() {
  const colorBlind = useStore((state) => state.colorBlind);
  const reducedMotion = useStore((state) => state.reducedMotion);
  const cameraMode = useStore((state) => state.cameraMode);
  const cameraReset = useStore((state) => state.cameraReset);
  const quality = useStore((state) => state.quality);
  const effectsIntensity = useStore((state) => state.effectsIntensity);
  const showLabels = useStore((state) => state.showLabels);
  const tvMode = useStore((state) => state.tvMode);

  const ticks = useStore((state) => state.visual?.ticks);
  const trail = useStore((state) => state.visual?.trail);
  const walls = useStore((state) => state.visual?.walls);

  const palette = paletteFor(colorBlind);
  const capacity = QUALITY_UNITS[quality];
  const particles = QUALITY_PARTICLES[quality];
  const shakeEnabled = effectsIntensity === 'cinematic' && !reducedMotion;

  return (
    <>
      <color attach="background" args={[palette.sky]} />
      <fog attach="fog" args={[palette.fog, 44, 105]} />

      <ambientLight intensity={0.5} />
      <hemisphereLight args={['#8fa6c4', '#0a0d12', 0.45]} />
      <directionalLight position={[10, 26, 14]} intensity={1.15} />
      {/* Rim lights tint each half of the field with its army's colour. */}
      <directionalLight position={[-30, 10, 6]} intensity={0.5} color={palette.bull} />
      <directionalLight position={[30, 10, 6]} intensity={0.5} color={palette.bear} />

      <ShakeGroup enabled={shakeEnabled}>
        <Terrain ticks={ticks ?? []} trail={trail ?? []} palette={palette} showLabels={showLabels} />
        <MemoArmy
          side="bull"
          color={palette.bull}
          darkColor={palette.bullDark}
          capacity={capacity}
          reducedMotion={reducedMotion}
        />
        <MemoArmy
          side="bear"
          color={palette.bear}
          darkColor={palette.bearDark}
          capacity={capacity}
          reducedMotion={reducedMotion}
        />
        <Fortifications
          walls={walls ?? []}
          palette={palette}
          showLabels={showLabels}
          reducedMotion={reducedMotion}
        />
        <SpreadZone palette={palette} showLabels={showLabels} />
        <FrontLine palette={palette} reducedMotion={reducedMotion} />
        <MemoEffects
          palette={palette}
          intensity={effectsIntensity}
          reducedMotion={reducedMotion}
          particleBudget={particles}
        />
        {showLabels && (
          <>
            <ArmyStandard side="bull" palette={palette} />
            <ArmyStandard side="bear" palette={palette} />
            <QuietBanner />
          </>
        )}
      </ShakeGroup>

      <PerformanceProbe />
      <CameraRig
        mode={cameraMode}
        resetSignal={cameraReset}
        reducedMotion={reducedMotion}
        tvMode={tvMode}
      />
    </>
  );
}

export function Battlefield() {
  const quality = useStore((state) => state.quality);
  const pauseRender = useStore((state) => state.pauseRender);

  return (
    <Canvas
      camera={{ position: CAMERA_HOME, fov: 45, near: 0.5, far: 220 }}
      dpr={QUALITY_DPR[quality]}
      frameloop={pauseRender ? 'never' : 'always'}
      gl={{ antialias: quality === 'high', powerPreference: 'high-performance' }}
    >
      <BattlefieldInner />
    </Canvas>
  );
}
