import { bboxPolygon, buffer, bbox, lineString, length, point, midpoint, featureEach, pointToLineDistance } from "@turf/turf"
import {
  findAdjacentRoad,
  calculateAngleBetweenLines,
  type RoadFeature,
  type RoadsCollection,
  edgeDirection,
  dotProduct,
} from "./geometry"
type ParcelGeometry = GeoJSON.Polygon | GeoJSON.MultiPolygon

export type ParcelProperties = {
  civic_number?: string | number
  streetname?: string
  full_address?: string
  site_id?: string
  tax_coord?: string
  [key: string]: unknown
}

export type ParcelFeature = GeoJSON.Feature<ParcelGeometry, ParcelProperties>

export type { RoadsCollection, RoadFeature }

export type ClassifiedEdge = {
  edge: GeoJSON.Feature<GeoJSON.LineString>
  type: "Side" | "Rear Lane" | "Frontage" | "Flankage" | "Rear"
  roadName: string | null
}

export type EdgeRoadCandidate = {
  edgeIndex: number
  roadName: string
  roadClass: string
  distance: number
  angle?: number
}

export function classifyEdgesWithContext(
  parcel: ParcelFeature,
  allRoads: RoadsCollection,
  parcelAddress: string
) : ClassifiedEdge[] {
  const primaryStreet = extractStreetName(parcelAddress).toLowerCase()
  const rawCoords = getFirstRingCoords(parcel.geometry)
  const coords = sanitizeCoords(rawCoords)

  if (coords.length < 2) {
    return []
  }

  // Parcel centroid: mean of vertices (excluding closing duplicate)
  const parcelVerts = coords.slice(0, -1)
  const parcelCentroid = parcelVerts.length > 0
    ? {
        x: parcelVerts.reduce((sum, c) => sum + c[0], 0) / parcelVerts.length,
        y: parcelVerts.reduce((sum, c) => sum + c[1], 0) / parcelVerts.length,
      }
    : { x: 0, y: 0 }

  const coordsBbox = getBboxFromCoords(coords)
  const bboxPoly = bboxPolygon(coordsBbox)
  const buffered = buffer(bboxPoly, 100, { units: "meters" })
  const bufferedBbox = buffered ? bbox(buffered) : coordsBbox
  const localRoads = filterRoadsByBbox(allRoads, bufferedBbox)

  const nonLaneRoads: RoadsCollection = {
    type: "FeatureCollection",
    features: localRoads.features.filter((road) => {
      const roadName = getRoadName(road)
      const roadClass = String(road.properties?.class || "")
      return !isLaneLike(roadClass, roadName)
    }),
  }
  const laneRoads: RoadsCollection = {
    type: "FeatureCollection",
    features: localRoads.features.filter((road) => {
      const roadName = getRoadName(road)
      const roadClass = String(road.properties?.class || "")
      return isLaneLike(roadClass, roadName)
    }),
  }
  const primaryStreetRoads: RoadsCollection = {
    type: "FeatureCollection",
    features: nonLaneRoads.features.filter((road) => {
      const roadName = getRoadName(road)
      return scoreRoadMatch(primaryStreet, roadName) > 0
    }),
  }

  const edgeInfos: Array<{
    edgeIndex: number
    edge: GeoJSON.Feature<GeoJSON.LineString>
    streetAdjacency: { road: RoadFeature; distance: number; angle?: number } | null
    laneAdjacency: { road: RoadFeature; distance: number; angle?: number } | null
    streetRoadName: string
    matchScore: number
    streetDistance: number
    streetMidpointDistance: number
    hasAnyRoadOrLaneAdjacency: boolean
  }> = []
  const streetAdjacencyThreshold = 38
  const primaryStreetThreshold = 70
  const primaryOverrideMaxDistance = 35
  const laneStrictThreshold = 3
  const laneFallbackThreshold = 6
  const anyRoadAdjacencyThreshold = 10
  const maxStreetAdjacencyForEdgeType = 30
  const maxFlankageStreetDistance = 14
  const maxFlankageStreetAngle = 42
  const maxFlankageDistanceFromSeed = 8
  const maxRearLaneDistanceFromSeed = 6
  const laneDominanceDistanceGap = 4

  for (let i = 0; i < coords.length - 1; i++) {
    const edge = lineString(
      [coords[i], coords[i + 1]]
    ) as GeoJSON.Feature<GeoJSON.LineString>

    let streetAdjacency = findAdjacentRoad(edge, nonLaneRoads, streetAdjacencyThreshold)
    const parallelStreetAdjacency = findAdjacentRoadWithAngle(
      edge,
      nonLaneRoads,
      streetAdjacencyThreshold,
      55
    )
    const primaryAdjacency = findAdjacentRoadWithAngle(
      edge,
      primaryStreetRoads,
      primaryStreetThreshold,
      55
    )
    const isParallel = (angle?: number) => angle === undefined || angle <= 55

    if ((!streetAdjacency || !isParallel(streetAdjacency.angle)) && parallelStreetAdjacency) {
      streetAdjacency = parallelStreetAdjacency
    }

    if (primaryAdjacency && isParallel(primaryAdjacency.angle)) {
      const currentRoadName = streetAdjacency ? getRoadName(streetAdjacency.road) : ""
      const currentMatchScore = scoreRoadMatch(primaryStreet, currentRoadName)
      const currentParallel = !streetAdjacency || isParallel(streetAdjacency.angle)
      const keepNearbySecondaryStreet =
        !!streetAdjacency &&
        currentMatchScore === 0 &&
        streetAdjacency.distance <= maxFlankageStreetDistance

      if (
        primaryAdjacency.distance <= primaryOverrideMaxDistance &&
        !keepNearbySecondaryStreet &&
        (
          !streetAdjacency ||
          !currentParallel ||
          primaryAdjacency.distance + 3 < streetAdjacency.distance ||
          (currentMatchScore === 0 && streetAdjacency.distance > maxFlankageStreetDistance)
        )
      ) {
        streetAdjacency = primaryAdjacency
      }
    }

    if (streetAdjacency && !isParallel(streetAdjacency.angle)) {
      streetAdjacency = null
    }

    // Find the nearest lane that is also parallel (≤30°) to this edge.
    // Using findAdjacentRoadWithAngle ensures we don't pick a closer but perpendicular
    // lane segment when a parallel lane exists slightly farther away.
    const laneAdjacencyRaw =
      findAdjacentRoadWithAngle(edge, laneRoads, laneStrictThreshold, 30) ||
      findAdjacentRoadWithAngle(edge, laneRoads, laneFallbackThreshold, 30)
    // For thin lots, the opposite long edge can also be within threshold of the same lane.
    // Verify the detected lane is on the EXTERIOR side of this edge (not the interior/lot side).
    const laneAdjacency = laneAdjacencyRaw && isLaneOnExteriorSide(edge, laneAdjacencyRaw.road, parcelCentroid)
      ? laneAdjacencyRaw
      : null
    const hasAnyRoadOrLaneAdjacency = !!findAdjacentRoad(
      edge,
      localRoads,
      anyRoadAdjacencyThreshold
    )

    const streetRoadName = streetAdjacency ? getRoadName(streetAdjacency.road) : ""
    const matchScore = scoreRoadMatch(primaryStreet, streetRoadName)

    // Midpoint-only distance to the detected street.
    // The 3-point min in findAdjacentRoad can be deceptively small when an endpoint
    // touches an intersection, or when the primary street override fires from far away.
    const streetMidpointDistance = (() => {
      if (!streetAdjacency) return Infinity
      const [mc0, mc1] = edge.geometry.coordinates
      const midPt = point([(mc0[0] + mc1[0]) / 2, (mc0[1] + mc1[1]) / 2])
      const geom = streetAdjacency.road.geometry
      const segs: GeoJSON.Feature<GeoJSON.LineString>[] = geom.type === "LineString"
        ? [lineString(geom.coordinates)]
        : geom.coordinates.map((c) => lineString(c))
      return segs.reduce((best, seg) => {
        const d = pointToLineDistance(midPt, seg, { units: "meters" })
        return d < best ? d : best
      }, Infinity)
    })()

    edgeInfos.push({
      edgeIndex: i,
      edge,
      streetAdjacency,
      laneAdjacency,
      streetRoadName,
      matchScore,
      streetDistance: streetAdjacency?.distance ?? Infinity,
      streetMidpointDistance,
      hasAnyRoadOrLaneAdjacency,
    })
  }

  const primaryMatchedStreetEdges = edgeInfos.filter(
    (info) => info.streetAdjacency && info.matchScore > 0
  )
  const anyStreetEdges = edgeInfos.filter((info) => info.streetAdjacency)
  const frontageCandidate = (primaryMatchedStreetEdges.length > 0
    ? primaryMatchedStreetEdges
    : anyStreetEdges
  )
    .slice()
    .sort((a, b) => {
      if (b.matchScore !== a.matchScore) return b.matchScore - a.matchScore
      if (a.streetDistance !== b.streetDistance) return a.streetDistance - b.streetDistance
      const aLen = length(a.edge, { units: "meters" })
      const bLen = length(b.edge, { units: "meters" })
      return aLen - bLen
    })[0]
  const frontageIndex = frontageCandidate?.edgeIndex ?? -1
  const frontageStreetDistance = frontageCandidate?.streetDistance ?? Infinity
  const frontageStreetNormalized = frontageCandidate
    ? normalizeStreetName(frontageCandidate.streetRoadName)
    : ""
  const edgeCount = edgeInfos.length
  const frontageIndexes = new Set<number>()
  const frontageEdge = frontageIndex >= 0 ? edgeInfos[frontageIndex].edge : null
  const isFrontageLike = (index: number): boolean => {
    if (frontageIndex < 0 || !frontageStreetNormalized || !frontageEdge) return false
    const info = edgeInfos[index]
    if (!info.streetAdjacency) return false
    if (info.matchScore <= 0) return false
    const streetNormalized = normalizeStreetName(info.streetRoadName)
    if (streetNormalized !== frontageStreetNormalized) return false
    // Edge must be roughly parallel to the frontage edge to be classified as Frontage
    const angleToFrontage = calculateAngleBetweenLines(info.edge, frontageEdge)
    if (angleToFrontage > 35) return false
    const maxFrontageDistance = Math.max(maxStreetAdjacencyForEdgeType, frontageStreetDistance + 18)
    return info.streetDistance <= maxFrontageDistance
  }
  if (frontageIndex >= 0) {
    frontageIndexes.add(frontageIndex)
    for (let step = 1; step < edgeCount; step++) {
      const index = (frontageIndex + step) % edgeCount
      if (!isFrontageLike(index)) break
      frontageIndexes.add(index)
    }
    for (let step = 1; step < edgeCount; step++) {
      const index = (frontageIndex - step + edgeCount) % edgeCount
      if (!isFrontageLike(index)) break
      frontageIndexes.add(index)
    }
  }

  const flankageCandidateByStreet = new Map<string, Array<{
    edgeIndex: number
    streetDistance: number
  }>>()

  for (const info of edgeInfos) {
    if (frontageIndexes.has(info.edgeIndex)) continue

    // Use a clean midpoint-based search for flankage adjacency.
    // Avoids all false positives from streetAdjacency (endpoint proximity, primary
    // override from far away, wrong-segment angle). findAdjacentRoadWithAngle already
    // uses midpoint-only distance and angle-first filtering.
    const directAdjacency = findAdjacentRoadWithAngle(
      info.edge, nonLaneRoads, maxFlankageStreetDistance, maxFlankageStreetAngle
    )
    if (!directAdjacency) continue

    const flankageRoadName = getRoadName(directAdjacency.road)
    const streetNormalized = normalizeStreetName(flankageRoadName)
    if (!streetNormalized || streetNormalized === frontageStreetNormalized) continue

    const laneDominatesStreet =
      !!info.laneAdjacency &&
      info.laneAdjacency.distance + laneDominanceDistanceGap < directAdjacency.distance
    if (laneDominatesStreet) continue

    const existing = flankageCandidateByStreet.get(streetNormalized) || []
    existing.push({
      edgeIndex: info.edgeIndex,
      streetDistance: directAdjacency.distance,
    })
    flankageCandidateByStreet.set(streetNormalized, existing)
  }

  const flankageIndexes = new Set<number>()
  for (const candidates of flankageCandidateByStreet.values()) {
    if (candidates.length === 0) continue

    const seed = candidates
      .slice()
      .sort((a, b) => a.streetDistance - b.streetDistance)[0]
    flankageIndexes.add(seed.edgeIndex)

    const indexToDistance = new Map<number, number>()
    for (const candidate of candidates) {
      indexToDistance.set(candidate.edgeIndex, candidate.streetDistance)
    }

    for (let step = 1; step < edgeCount; step++) {
      const index = (seed.edgeIndex + step) % edgeCount
      const distance = indexToDistance.get(index)
      if (distance === undefined) break
      if (distance > seed.streetDistance + maxFlankageDistanceFromSeed) break
      flankageIndexes.add(index)
    }

    for (let step = 1; step < edgeCount; step++) {
      const index = (seed.edgeIndex - step + edgeCount) % edgeCount
      const distance = indexToDistance.get(index)
      if (distance === undefined) break
      if (distance > seed.streetDistance + maxFlankageDistanceFromSeed) break
      flankageIndexes.add(index)
    }
  }

  // Key by road object reference so each distinct lane road is its own group.
  // Named lanes sharing the same name are still merged via a secondary string-keyed map.
  const rearLaneCandidateByRoad = new Map<object, Array<{
    edgeIndex: number
    laneDistance: number
  }>>()
  const namedLaneKeyMap = new Map<string, object>()
  for (const info of edgeInfos) {
    if (frontageIndexes.has(info.edgeIndex)) continue
    if (flankageIndexes.has(info.edgeIndex)) continue
    if (!info.laneAdjacency) continue

    const laneName = getRoadName(info.laneAdjacency.road).toLowerCase().trim()
    // For named lanes, merge all segments of the same name under one key
    let mapKey: object
    if (laneName) {
      if (!namedLaneKeyMap.has(laneName)) namedLaneKeyMap.set(laneName, {})
      mapKey = namedLaneKeyMap.get(laneName)!
    } else {
      // Unnamed lanes: each road feature is its own group (no cross-edge contamination)
      mapKey = info.laneAdjacency.road
    }

    const existing = rearLaneCandidateByRoad.get(mapKey) || []
    existing.push({
      edgeIndex: info.edgeIndex,
      laneDistance: info.laneAdjacency.distance,
    })
    rearLaneCandidateByRoad.set(mapKey, existing)
  }

  const rearLaneIndexes = new Set<number>()
  for (const candidates of rearLaneCandidateByRoad.values()) {
    if (candidates.length === 0) continue

    const seed = candidates
      .slice()
      .sort((a, b) => a.laneDistance - b.laneDistance)[0]
    rearLaneIndexes.add(seed.edgeIndex)

    const indexToDistance = new Map<number, number>()
    for (const candidate of candidates) {
      indexToDistance.set(candidate.edgeIndex, candidate.laneDistance)
    }

    for (let step = 1; step < edgeCount; step++) {
      const index = (seed.edgeIndex + step) % edgeCount
      const distance = indexToDistance.get(index)
      if (distance === undefined) break
      if (distance > seed.laneDistance + maxRearLaneDistanceFromSeed) break
      rearLaneIndexes.add(index)
    }

    for (let step = 1; step < edgeCount; step++) {
      const index = (seed.edgeIndex - step + edgeCount) % edgeCount
      const distance = indexToDistance.get(index)
      if (distance === undefined) break
      if (distance > seed.laneDistance + maxRearLaneDistanceFromSeed) break
      rearLaneIndexes.add(index)
    }
  }

  const results: ClassifiedEdge[] = edgeInfos.map((info) => {
    let type: ClassifiedEdge["type"] = "Side"

    if (frontageIndexes.has(info.edgeIndex)) {
      type = "Frontage"
    } else if (flankageIndexes.has(info.edgeIndex)) {
      type = "Flankage"
    } else if (rearLaneIndexes.has(info.edgeIndex)) {
      type = "Rear Lane"
    }

    return {
      edge: info.edge,
      type,
      roadName: info.streetRoadName || (info.laneAdjacency ? getRoadName(info.laneAdjacency.road) : null) || null,
    }
  })

  // Fill pass: a Side edge sandwiched between two Rear Lane edges on the perimeter
  // is part of the same rear zone (the lane bends at the corner of irregular parcels).
  for (let i = 0; i < results.length; i++) {
    if (results[i].type !== "Side") continue
    const prev = results[(i - 1 + results.length) % results.length]
    const next = results[(i + 1) % results.length]
    if (prev.type === "Rear Lane" && next.type === "Rear Lane") {
      results[i].type = "Rear Lane"
    }
  }


  if (frontageIndex >= 0) {
    const frontageBoundaryNeighbors = new Set<number>()
    frontageIndexes.forEach((idx) => {
      frontageBoundaryNeighbors.add((idx - 1 + edgeCount) % edgeCount)
      frontageBoundaryNeighbors.add((idx + 1) % edgeCount)
    })
    frontageIndexes.forEach((idx) => frontageBoundaryNeighbors.delete(idx))

    const frontageDirs = Array.from(frontageIndexes).map((idx) => {
      const dir = edgeDirection(edgeInfos[idx].edge)
      const len = Math.hypot(dir.dx, dir.dy)
      if (len === 0) return { dx: 0, dy: 0 }
      return { dx: dir.dx / len, dy: dir.dy / len }
    })
    const frontageDir =
      frontageDirs.length > 0
        ? frontageDirs.reduce(
            (acc, dir) => ({ dx: acc.dx + dir.dx, dy: acc.dy + dir.dy }),
            { dx: 0, dy: 0 }
          )
        : edgeDirection(edgeInfos[frontageIndex].edge)

    const frontageLen = Math.hypot(frontageDir.dx, frontageDir.dy)
    const frontageUnit =
      frontageLen > 0
        ? { dx: frontageDir.dx / frontageLen, dy: frontageDir.dy / frontageLen }
        : { dx: 0, dy: 0 }

    const rearParallelCosineThreshold = -0.65
    const pickRearCandidate = (requireNoAdjacency: boolean, skipBoundaryNeighbors: boolean) => {
      let bestIndex = -1
      let bestCosine = Infinity

      for (let index = 0; index < edgeInfos.length; index++) {
        if (frontageIndexes.has(index)) continue
        if (skipBoundaryNeighbors && frontageBoundaryNeighbors.has(index)) continue
        if (results[index].type !== "Side") continue

        const info = edgeInfos[index]
        // Edges directly adjacent to a named street (midpoint within flankage threshold) are
        // never Rear. We use midpoint distance to avoid false positives from:
        // (a) endpoint-touching (shared corners with adjacent edges near a road/lane)
        // (b) primary street override detecting the frontage street from far away (opposite side of lot)
        if (info.streetMidpointDistance <= maxFlankageStreetDistance) continue
        if (requireNoAdjacency && info.hasAnyRoadOrLaneAdjacency) continue

        const dir = edgeDirection(info.edge)
        const len = Math.hypot(dir.dx, dir.dy)
        if (len === 0) continue
        const unit = { dx: dir.dx / len, dy: dir.dy / len }
        const cosine = dotProduct(frontageUnit, unit)
        if (cosine > rearParallelCosineThreshold) continue
        if (cosine < bestCosine) {
          bestCosine = cosine
          bestIndex = index
        }
      }

      return bestIndex
    }

    // Three-tier fallback:
    // 1. No road/lane adjacency, exclude boundary neighbors (ideal rear)
    // 2. Any adjacency, exclude boundary neighbors
    // 3. Any adjacency, include boundary neighbors (last resort for irregular parcels)
    let rearCandidateIndex = pickRearCandidate(true, true)
    if (rearCandidateIndex < 0) {
      rearCandidateIndex = pickRearCandidate(false, true)
    }
    if (rearCandidateIndex < 0) {
      rearCandidateIndex = pickRearCandidate(false, false)
    }

    if (rearCandidateIndex >= 0) {
      results[rearCandidateIndex].type = "Rear"
    }
  }

  return results
}

/**
 * Returns true if the nearest point of `laneRoad` to the edge midpoint
 * lies on the exterior (outward-facing) side of the edge relative to the parcel centroid.
 * Prevents thin lots from detecting the lane on the opposite side of the parcel.
 */
function isLaneOnExteriorSide(
  edge: GeoJSON.Feature<GeoJSON.LineString>,
  laneRoad: RoadFeature,
  centroid: { x: number; y: number }
): boolean {
  const [c0, c1] = edge.geometry.coordinates
  const midX = (c0[0] + c1[0]) / 2
  const midY = (c0[1] + c1[1]) / 2

  const edgeDir = edgeDirection(edge)
  const edgeLen = Math.hypot(edgeDir.dx, edgeDir.dy)
  if (edgeLen === 0) return true

  // Unit perpendicular to the edge (two candidates; pick the one pointing away from centroid)
  const perpX = -edgeDir.dy / edgeLen
  const perpY = edgeDir.dx / edgeLen
  const outSign = perpX * (midX - centroid.x) + perpY * (midY - centroid.y) >= 0 ? 1 : -1
  const outwardX = perpX * outSign
  const outwardY = perpY * outSign

  // Find the lane coordinate nearest to the edge midpoint
  const laneGeom = laneRoad.geometry
  const allLaneCoords: GeoJSON.Position[] =
    laneGeom.type === "LineString"
      ? laneGeom.coordinates
      : laneGeom.coordinates.flat()
  let nearestCoord = allLaneCoords[0]
  let nearestDistSq = Infinity
  for (const coord of allLaneCoords) {
    const dx = coord[0] - midX
    const dy = coord[1] - midY
    const distSq = dx * dx + dy * dy
    if (distSq < nearestDistSq) {
      nearestDistSq = distSq
      nearestCoord = coord
    }
  }

  // Lane is exterior if nearest lane point is in the outward direction
  const toLaneX = nearestCoord[0] - midX
  const toLaneY = nearestCoord[1] - midY
  return outwardX * toLaneX + outwardY * toLaneY > 0
}

function findAdjacentRoadWithAngle(
  edge: GeoJSON.Feature<GeoJSON.LineString>,
  roadFeatures: RoadsCollection,
  threshold: number,
  maxAngle: number
): { road: RoadFeature; distance: number; angle?: number } | null {
  const [c0, c1] = edge.geometry.coordinates
  const midPt = point([(c0[0] + c1[0]) / 2, (c0[1] + c1[1]) / 2])

  let bestRoad: RoadFeature | null = null
  let bestDistance = Infinity
  let bestAngle: number | undefined

  featureEach(roadFeatures, (road) => {
    const geometry = road.geometry
    const candidateLines: GeoJSON.Feature<GeoJSON.LineString>[] =
      geometry.type === "LineString"
        ? [lineString(geometry.coordinates)]
        : geometry.coordinates.map((coords) => lineString(coords))

    for (const line of candidateLines) {
      // Angle filter first (cheap) — only parallel lanes qualify
      const angle = calculateAngleBetweenLines(edge, line)
      if (angle > maxAngle) continue

      // Distance measured from the edge midpoint only
      const distance = pointToLineDistance(midPt, line, { units: "meters" })
      if (distance > threshold) continue

      if (distance < bestDistance) {
        bestRoad = road as RoadFeature
        bestDistance = distance
        bestAngle = angle
      }
    }
  })

  if (!bestRoad) return null
  return {
    road: bestRoad,
    distance: bestDistance,
    angle: bestAngle,
  }
}

export function getEdgeRoadCandidates(
  parcel: ParcelFeature,
  allRoads: RoadsCollection,
  maxDistance = 60,
  perEdgeLimit = 5
): EdgeRoadCandidate[] {
  const rawCoords = getFirstRingCoords(parcel.geometry)
  const coords = sanitizeCoords(rawCoords)
  if (coords.length < 2) return []

  const coordsBbox = getBboxFromCoords(coords)
  const bboxPoly = bboxPolygon(coordsBbox)
  const buffered = buffer(bboxPoly, 100, { units: "meters" })
  const bufferedBbox = buffered ? bbox(buffered) : coordsBbox
  const localRoads = filterRoadsByBbox(allRoads, bufferedBbox)

  const output: EdgeRoadCandidate[] = []

  for (let i = 0; i < coords.length - 1; i++) {
    const edge = lineString(
      [coords[i], coords[i + 1]]
    ) as GeoJSON.Feature<GeoJSON.LineString>

    const startPoint = point(edge.geometry.coordinates[0])
    const endPoint = point(edge.geometry.coordinates[1])
    const midPt = midpoint(startPoint, endPoint)
    const samplePoints = [startPoint, midPt, endPoint]

    const candidates: EdgeRoadCandidate[] = []

    featureEach(localRoads, (road) => {
      const roadName = getRoadName(road)
      if (!roadName) return

      let minDistance = Infinity
      let bestLine: GeoJSON.Feature<GeoJSON.LineString> | null = null
      const geometry = road.geometry

      if (geometry.type === "LineString") {
        const line = lineString(geometry.coordinates)
        minDistance = samplePoints.reduce((best, point) => {
          const d = pointToLineDistance(point, line, { units: "meters" })
          return d < best ? d : best
        }, Infinity)
        bestLine = line
      } else if (geometry.type === "MultiLineString") {
        for (const coords of geometry.coordinates) {
          const line = lineString(coords)
          const d = samplePoints.reduce((best, point) => {
            const distance = pointToLineDistance(point, line, {
              units: "meters",
            })
            return distance < best ? distance : best
          }, Infinity)
          if (d < minDistance) {
            minDistance = d
            bestLine = line
          }
        }
      }

      if (minDistance > maxDistance) return

      const angle = bestLine
        ? calculateAngleBetweenLines(edge, bestLine)
        : undefined

      candidates.push({
        edgeIndex: i,
        roadName,
        roadClass: String(road.properties?.class || ""),
        distance: minDistance,
        angle,
      })
    })

    candidates
      .sort((a, b) => a.distance - b.distance)
      .slice(0, perEdgeLimit)
      .forEach((candidate) => output.push(candidate))
  }

  return output
}

function extractStreetName(address: string): string {
  // Remove leading civic number only; normalizeStreetName handles suffix stripping
  return address.replace(/^\d+\s+/, "").trim()
}

function normalizeStreetName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[0-9]/g, " ")
    .replace(/street|st\.?|avenue|ave\.?|road|rd\.?|drive|dr\.?|boulevard|blvd\.?|lane|ln\.?|alley|aly\.?/g, "")
    .replace(/[^a-z\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
}

function scoreRoadMatch(primaryStreet: string, roadName: string): number {
  if (!primaryStreet || !roadName) return 0

  const primary = normalizeStreetName(primaryStreet)
  const road = normalizeStreetName(roadName)

  if (!primary || !road) return 0
  if (primary === road) return 3
  if (road.includes(primary) || primary.includes(road)) return 2

  const primaryTokens = new Set(primary.split(" "))
  const roadTokens = new Set(road.split(" "))
  let overlap = 0

  for (const token of primaryTokens) {
    if (roadTokens.has(token)) overlap += 1
  }

  return overlap > 0 ? 1 : 0
}

function isLaneLike(roadClass: string, roadName: string): boolean {
  const klass = String(roadClass || "").toLowerCase()
  const name = (roadName || "").toLowerCase()
  return (
    klass === "lane" ||
    klass === "alley" ||
    klass === "service" ||
    klass.includes("lane") ||
    klass.includes("alley") ||
    name.includes("lane") ||
    name.includes("alley")
  )
}

function getRoadName(road: RoadFeature): string {
  const properties = road.properties || {}
  const stdStreet = (properties.std_street as string) || ""
  const fromBlock = (properties.from_hundred_block as string) || ""
  const laneBlockName = [fromBlock, stdStreet].filter(Boolean).join(" ").trim()
  const name =
    (properties.name as string) ||
    (properties.streetname as string) ||
    (properties.full_name as string) ||
    (properties.routename as string) ||
    stdStreet ||
    laneBlockName ||
    (properties.hblock as string) ||
    ""

  if (!name) return ""

  const parts = name.trim().split(/\s+/)
  if (parts.length > 1 && /^\d+$/.test(parts[0])) {
    return parts.slice(1).join(" ")
  }

  return name
}

function filterRoadsByBbox(
  roads: RoadsCollection,
  bbox: GeoJSON.BBox
): RoadsCollection {
  const [minX, minY, maxX, maxY] = bbox
  const features = roads.features.filter((road) => {
    const geom = road.geometry
    const coordArrays: GeoJSON.Position[][] =
      geom.type === "LineString"
        ? [geom.coordinates]
        : geom.coordinates
    return coordArrays.some((coords) => {
      // Fast path: any coord is inside bbox
      if (coords.some(([x, y]) => x >= minX && x <= maxX && y >= minY && y <= maxY)) return true
      // Fallback: road's own bbox overlaps the filter bbox (catches roads that pass through
      // the filter bbox without having an endpoint inside it)
      let rMinX = Infinity, rMinY = Infinity, rMaxX = -Infinity, rMaxY = -Infinity
      for (const [x, y] of coords) {
        if (x < rMinX) rMinX = x
        if (y < rMinY) rMinY = y
        if (x > rMaxX) rMaxX = x
        if (y > rMaxY) rMaxY = y
      }
      return rMaxX >= minX && rMinX <= maxX && rMaxY >= minY && rMinY <= maxY
    })
  })
  return { type: "FeatureCollection", features }
}

function getFirstRingCoords(geometry: ParcelGeometry): GeoJSON.Position[] {
  if (geometry.type === "Polygon") {
    return geometry.coordinates[0]
  }

  return geometry.coordinates[0][0]
}

function sanitizeCoords(coords: GeoJSON.Position[]): GeoJSON.Position[] {
  return coords.filter(
    (coord): coord is GeoJSON.Position =>
      Array.isArray(coord) &&
      coord.length >= 2 &&
      typeof coord[0] === "number" &&
      typeof coord[1] === "number"
  )
}

function getBboxFromCoords(coords: GeoJSON.Position[]): GeoJSON.BBox {
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity

  for (const coord of coords) {
    const [x, y] = coord
    if (x < minX) minX = x
    if (y < minY) minY = y
    if (x > maxX) maxX = x
    if (y > maxY) maxY = y
  }

  return [minX, minY, maxX, maxY]
}
