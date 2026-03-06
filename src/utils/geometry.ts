import { lineString, midpoint, point, length, featureEach, pointToLineDistance } from "@turf/turf"

export type RoadGeometry = GeoJSON.LineString | GeoJSON.MultiLineString
export type RoadProperties = {
  name?: string
  class?: string
  [key: string]: unknown
} | null
export type RoadFeature = GeoJSON.Feature<RoadGeometry, RoadProperties>
export type RoadsCollection = GeoJSON.FeatureCollection<RoadGeometry, RoadProperties>

export function extractEdges(
  polygon: GeoJSON.Feature<GeoJSON.Polygon | GeoJSON.MultiPolygon>
) {
  const coords =
    polygon.geometry.type === "Polygon"
      ? polygon.geometry.coordinates[0]
      : polygon.geometry.coordinates[0][0]
  const edges: GeoJSON.Feature<GeoJSON.LineString>[] = []

  for (let i = 0; i < coords.length - 1; i++) {
    edges.push(
      lineString([coords[i], coords[i + 1]], { index: i })
    )
  }

  return edges
}

export function edgeMidpoint(edge: GeoJSON.Feature<GeoJSON.LineString>) {
  return midpoint(
    point(edge.geometry.coordinates[0]),
    point(edge.geometry.coordinates[1])
  )
}

export function edgeLength(edge: GeoJSON.Feature<GeoJSON.LineString>) {
  return length(edge, { units: "meters" })
}

export function edgeDirection(edge: GeoJSON.Feature<GeoJSON.LineString>) {
  const coords = edge.geometry.coordinates
  const a = coords[0]
  const b = coords[coords.length - 1]
  return {
    dx: b[0] - a[0],
    dy: b[1] - a[1],
  }
}

export function dotProduct(v1: { dx: number; dy: number }, v2: { dx: number; dy: number }) {
  return v1.dx * v2.dx + v1.dy * v2.dy
}

export function calculateAngleBetweenLines(
  line1: GeoJSON.Feature<GeoJSON.LineString>,
  line2: GeoJSON.Feature<GeoJSON.LineString>
): number {
  const dir1 = edgeDirection(line1)
  const dir2 = edgeDirection(line2)
  
  const len1 = Math.sqrt(dir1.dx * dir1.dx + dir1.dy * dir1.dy)
  const len2 = Math.sqrt(dir2.dx * dir2.dx + dir2.dy * dir2.dy)
  
  if (len1 === 0 || len2 === 0) return 0
  
  const dot = dotProduct(dir1, dir2)
  const cosAngle = dot / (len1 * len2)
  
  const angleRad = Math.acos(Math.max(-1, Math.min(1, cosAngle)))
  const angleDeg = (angleRad * 180) / Math.PI
  
  return angleDeg > 90 ? 180 - angleDeg : angleDeg
}
export function findAdjacentRoad(
  edge: GeoJSON.Feature<GeoJSON.LineString>,
  roadFeatures: RoadsCollection,
  threshold = 15
) : { road: RoadFeature; distance: number; angle?: number } | null {
  const startPoint = point(edge.geometry.coordinates[0])
  const endPoint = point(edge.geometry.coordinates[1])
  const midPt = midpoint(startPoint, endPoint)
  const samplePoints = [startPoint, midPt, endPoint]

  let nearestRoad: RoadFeature | null = null
  let nearestRoadLine: GeoJSON.Feature<GeoJSON.LineString> | null = null
  let minDistance = Infinity

  featureEach(roadFeatures, (road) => {
    const geometry = road.geometry

    if (geometry.type === "LineString") {
      const line = lineString(geometry.coordinates, road.properties)
      const distance = samplePoints.reduce((best, pt) => {
        const d = pointToLineDistance(pt, line, { units: "meters" })
        return d < best ? d : best
      }, Infinity)

      if (distance < minDistance) {
        minDistance = distance
        nearestRoad = road as RoadFeature
        nearestRoadLine = line
      }
      return
    }

    if (geometry.type === "MultiLineString") {
      for (const coords of geometry.coordinates) {
        const line = lineString(coords)
        const distance = samplePoints.reduce((best, pt) => {
          const d = pointToLineDistance(pt, line, { units: "meters" })
          return d < best ? d : best
        }, Infinity)

        if (distance < minDistance) {
          minDistance = distance
          nearestRoad = road as RoadFeature
          nearestRoadLine = line
        }
      }
    }
  })

  if (!nearestRoad || minDistance > threshold) {
    return null
  }

  const roadToAnalyze: RoadFeature = nearestRoad
  let angle: number | undefined
  if (nearestRoadLine) {
    angle = calculateAngleBetweenLines(edge, nearestRoadLine)
  }
  
  return {
    road: roadToAnalyze,
    distance: minDistance,
    angle,
  }
}
