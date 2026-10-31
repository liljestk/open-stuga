interface PlanPoint { x: number; y: number }

// Plan units: `.rooms text` is drawn at 15 units and a sensor halo has a
// 28-unit radius, so both can be compared directly in render coordinates.
const ROOM_LABEL_HEIGHT = 15;
const ROOM_LABEL_CHARACTER_WIDTH = 8.5;
const SENSOR_MARKER_RADIUS = 28;

/**
 * A room name sits at the room's centroid unless a sensor marker covers it;
 * then the name moves just above that marker, staying inside the room.
 */
export function roomLabelPoint({ name, center, roomTop, markers }: {
  name: string;
  center: PlanPoint;
  roomTop: number;
  markers: readonly PlanPoint[];
}): PlanPoint {
  const halfWidth = name.length * ROOM_LABEL_CHARACTER_WIDTH / 2;
  const covering = markers.find((marker) => Math.abs(marker.x - center.x) < halfWidth + SENSOR_MARKER_RADIUS
    && Math.abs(marker.y - center.y) < SENSOR_MARKER_RADIUS + ROOM_LABEL_HEIGHT);
  if (!covering) return center;
  return { x: center.x, y: Math.max(roomTop + ROOM_LABEL_HEIGHT + 4, covering.y - SENSOR_MARKER_RADIUS - 10) };
}
