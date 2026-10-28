

export type LayoutPoint = { x: number; y: number };

export function roomPolygonSelfIntersects(points: LayoutPoint[], coordinateScale: number): boolean {
  const linearTolerance = Math.max(1, coordinateScale) * 1e-10;
  const crossTolerance = Math.max(1, coordinateScale * coordinateScale) * 1e-10;
  const cross = (a: LayoutPoint, b: LayoutPoint, c: LayoutPoint) => (
    (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x)
  );
  const onSegment = (a: LayoutPoint, b: LayoutPoint, point: LayoutPoint) => (
    Math.abs(cross(a, b, point)) <= crossTolerance
    && point.x >= Math.min(a.x, b.x) - linearTolerance
    && point.x <= Math.max(a.x, b.x) + linearTolerance
    && point.y >= Math.min(a.y, b.y) - linearTolerance
    && point.y <= Math.max(a.y, b.y) + linearTolerance
  );
  const segmentsIntersect = (a: LayoutPoint, b: LayoutPoint, c: LayoutPoint, d: LayoutPoint) => {
    const abC = cross(a, b, c);
    const abD = cross(a, b, d);
    const cdA = cross(c, d, a);
    const cdB = cross(c, d, b);
    const crossesProperly = ((abC > crossTolerance && abD < -crossTolerance) || (abC < -crossTolerance && abD > crossTolerance))
      && ((cdA > crossTolerance && cdB < -crossTolerance) || (cdA < -crossTolerance && cdB > crossTolerance));
    return crossesProperly
      || onSegment(a, b, c)
      || onSegment(a, b, d)
      || onSegment(c, d, a)
      || onSegment(c, d, b);
  };

  for (let firstIndex = 0; firstIndex < points.length; firstIndex += 1) {
    const firstNext = (firstIndex + 1) % points.length;
    for (let secondIndex = firstIndex + 1; secondIndex < points.length; secondIndex += 1) {
      const secondNext = (secondIndex + 1) % points.length;
      // Consecutive edges are expected to meet at their shared vertex.
      if (firstNext === secondIndex || secondNext === firstIndex) continue;
      if (segmentsIntersect(points[firstIndex]!, points[firstNext]!, points[secondIndex]!, points[secondNext]!)) return true;
    }
  }
  return false;
}
