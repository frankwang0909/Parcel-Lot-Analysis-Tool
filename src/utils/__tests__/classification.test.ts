import { describe, it, expect } from "vitest"
import { lineString } from "@turf/turf"
import { classifyLot } from "../classification"
import type { ClassifiedEdge } from "../geoAnalysis"

// Helper: create a ClassifiedEdge with real edge geometry.
// coords must be [[lng0, lat0], [lng1, lat1]] so edgeDirection works correctly.
function makeEdge(
  type: ClassifiedEdge["type"],
  coords: [[number, number], [number, number]],
  roadName: string | null = null
): ClassifiedEdge {
  return {
    edge: lineString(coords) as GeoJSON.Feature<GeoJSON.LineString>,
    type,
    roadName,
  }
}

// Shared rectangular-lot edges (E-W frontage, N-S sides)
//   Edge directions:
//     frontage:     east  (dx>0, dy=0)  unit = (+1, 0)
//     sideEast:     north (dx=0, dy>0)
//     antiParallel: west  (dx<0, dy=0)  cosine with frontage = -1  < -0.65 ✓
//     parallel:     east  (dx>0, dy=0)  cosine with frontage = +1  > -0.65 ✗
//     sideWest:     south (dx=0, dy<0)

const frontage         = makeEdge("Frontage",  [[-1, 0], [1, 0]], "Main Street")   // east
const sideEast         = makeEdge("Side",       [[1, 0],  [1, 1]], null)
const sideWest         = makeEdge("Side",       [[-1, 1], [-1, 0]], null)
const rearEdge         = makeEdge("Rear",       [[1, 1],  [-1, 1]], null)           // west
const rearLaneAnti     = makeEdge("Rear Lane",  [[1, 1],  [-1, 1]], null)           // west  → anti-parallel
const rearLaneParallel = makeEdge("Rear Lane",  [[-1, 1], [1, 1]], null)            // east  → parallel

describe("classifyLot", () => {
  it("returns 'Standard without Lane' for a basic Frontage + Rear + Side lot", () => {
    expect(classifyLot([frontage, sideEast, rearEdge, sideWest])).toBe("Standard without Lane")
  })

  it("returns 'Standard with Lane' when a Rear Lane edge is anti-parallel to Frontage", () => {
    // rearLaneAnti is west-bound → cosine with east-bound frontage = -1 < -0.65
    expect(classifyLot([frontage, sideEast, rearLaneAnti, sideWest])).toBe("Standard with Lane")
  })

  it("returns 'Standard without Lane' when Rear Lane is parallel (not anti-parallel) to Frontage", () => {
    // rearLaneParallel is east-bound → cosine = +1 > -0.65 → condition not met
    expect(classifyLot([frontage, sideEast, rearLaneParallel, sideWest])).toBe("Standard without Lane")
  })

  it("returns 'Corner Lot' when both Frontage and Flankage edges exist", () => {
    const flankage = makeEdge("Flankage", [[1, 0], [1, 1]], "Cross Street")
    expect(classifyLot([frontage, flankage, rearEdge, sideWest])).toBe("Corner Lot")
  })

  it("returns 'Double Fronting' when Frontage edges face two different street names", () => {
    const frontage2 = makeEdge("Frontage", [[1, 1], [-1, 1]], "Back Street")
    expect(classifyLot([frontage, sideEast, frontage2, sideWest])).toBe("Double Fronting")
  })

  it("does NOT return 'Double Fronting' when both Frontage edges share the same road name", () => {
    const frontage2 = makeEdge("Frontage", [[1, 1], [-1, 1]], "Main Street")
    // roadNames.size === 1 → not Double Fronting
    expect(classifyLot([frontage, sideEast, frontage2, sideWest])).not.toBe("Double Fronting")
  })

  it("does NOT return 'Double Fronting' when both Frontage edges have null roadName", () => {
    const f1 = makeEdge("Frontage", [[-1, 0], [1, 0]], null)
    const f2 = makeEdge("Frontage", [[1, 1], [-1, 1]], null)
    // Both coalesce to "" → roadNames.size === 1 → not Double Fronting
    expect(classifyLot([f1, sideEast, f2, sideWest])).not.toBe("Double Fronting")
  })

  it("'Corner Lot' takes priority over 'Standard with Lane'", () => {
    const flankage = makeEdge("Flankage", [[1, 0], [1, 1]], "Cross Street")
    expect(classifyLot([frontage, flankage, rearLaneAnti, sideWest])).toBe("Corner Lot")
  })

  it("'Corner Lot' takes priority over 'Double Fronting'", () => {
    const flankage  = makeEdge("Flankage", [[1, 0], [1, 1]], "Cross Street")
    const frontage2 = makeEdge("Frontage", [[1, 1], [-1, 1]], "Back Street")
    expect(classifyLot([frontage, flankage, frontage2, sideWest])).toBe("Corner Lot")
  })

  it("'Double Fronting' takes priority over 'Standard with Lane'", () => {
    const frontage2 = makeEdge("Frontage", [[1, 1], [-1, 1]], "Back Street")
    expect(classifyLot([frontage, sideEast, frontage2, rearLaneAnti])).toBe("Double Fronting")
  })

  it("returns 'Standard without Lane' when there are no Frontage edges", () => {
    expect(classifyLot([sideEast, sideWest, rearEdge])).toBe("Standard without Lane")
  })

  it("returns 'Standard without Lane' for an empty edge list", () => {
    expect(classifyLot([])).toBe("Standard without Lane")
  })

  it("returns 'Standard with Lane' when no Rear edge is present but a Rear Lane is anti-parallel", () => {
    // Triangle-like lot: Frontage + Side + Rear Lane only
    expect(classifyLot([frontage, sideEast, rearLaneAnti])).toBe("Standard with Lane")
  })

  it("multiple Rear Lane edges: at least one anti-parallel is enough for 'Standard with Lane'", () => {
    // One parallel lane (irrelevant) + one anti-parallel lane (triggers the check)
    const rl2 = makeEdge("Rear Lane", [[0.5, 1], [-0.5, 1]], null) // short, west = anti-parallel
    expect(classifyLot([frontage, rearLaneParallel, rl2, sideWest])).toBe("Standard with Lane")
  })
})
