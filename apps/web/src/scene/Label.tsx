import { useMemo } from 'react';
import type { LabelStyleName } from './labels';
import { getLabel } from './labels';

interface LabelProps {
  text: string;
  style: LabelStyleName;
  position: [number, number, number];
  /** World-space height of the label; width follows the text aspect ratio. */
  size?: number;
  opacity?: number;
  renderOrder?: number;
}

/** Camera-facing text sprite backed by the cached canvas-texture atlas. */
export function Label({
  text,
  style,
  position,
  size = 0.62,
  opacity = 1,
  renderOrder = 10,
}: LabelProps) {
  const { texture, aspect } = useMemo(() => getLabel(text, style), [text, style]);

  return (
    <sprite position={position} scale={[size * aspect, size, 1]} renderOrder={renderOrder}>
      <spriteMaterial
        map={texture}
        transparent
        opacity={opacity}
        depthWrite={false}
        depthTest={false}
        toneMapped={false}
      />
    </sprite>
  );
}
