import { describe, it, expect } from "vitest"
import { classifyEdgesWithContext } from "../geoAnalysis"
import { classifyLot } from "../classification"
import type { ParcelFeature, RoadsCollection } from "../geoAnalysis"

// ─── Coordinate constants ────────────────────────────────────────────────────
//
// Rectangular parcel in downtown Vancouver (~72m wide × ~111m deep)
//   At 49.28 °N:  1° lat ≈ 111 194 m,  1° lng ≈ 72 502 m
//
// Edges (in polygon order SW→SE→NE→NW→SW):
//   Edge 0 (south):  SW → SE   east direction  — will be Frontage
//   Edge 1 (east):   SE → NE   north direction — will be Side / Flankage
//   Edge 2 (north):  NE → NW   west direction  — will be Rear Lane / Rear
//   Edge 3 (west):   NW → SW   south direction — will be Side

const W = -123.121   // west bound
const S =  49.280    // south bound
const E = -123.120   // east bound   (0.001° lng ≈ 72.5 m)
const N =  49.281    // north bound  (0.001° lat ≈ 111 m)

// ─── Parcel factory ──────────────────────────────────────────────────────────

function makeParcel(): ParcelFeature {
  return {
    type: "Feature",
    geometry: {
      type: "Polygon",
      // SW → SE → NE → NW → SW (closes polygon)
      coordinates: [[[W, S], [E, S], [E, N], [W, N], [W, S]]],
    },
    properties: {},
  }
}

// ─── Road factories ──────────────────────────────────────────────────────────

type RoadFeat = RoadsCollection["features"][0]

function road(
  coords: [number, number][],
  name: string,
  cls = "street"
): RoadFeat {
  return {
    type: "Feature",
    geometry: { type: "LineString", coordinates: coords },
    properties: { name, class: cls },
  }
}

function roads(...features: RoadFeat[]): RoadsCollection {
  return { type: "FeatureCollection", features }
}

// Main Street: E-W, 3 m south of the south edge
// Distance from Edge-0 midpoint: ~3 m < streetAdjacencyThreshold (38 m) ✓
const MAIN_ST_Y = S - 3 / 111_194  // ≈ 0.0000270°
const mainStreet = road(
  [[W - 0.002, MAIN_ST_Y], [E + 0.002, MAIN_ST_Y]],
  "Main Street",
)

// Back Lane: E-W, 4 m north of the north edge (class="service" → lane)
// Distance from Edge-2 midpoint: ~4 m < laneFallbackThreshold (6 m) ✓
const LANE_Y = N + 4 / 111_194  // ≈ 0.0000360°
const backLane = road(
  [[W - 0.002, LANE_Y], [E + 0.002, LANE_Y]],
  "Back Lane",
  "service",   // isLaneLike → class === "service"
)

// Cross Street: N-S, 8 m east of the east edge
// Distance from Edge-1 midpoint: ~8 m < maxFlankageStreetDistance (14 m) ✓
const CROSS_ST_X = E + 8 / 72_502  // ≈ 0.000110°
const crossStreet = road(
  [[CROSS_ST_X, S - 0.002], [CROSS_ST_X, N + 0.002]],
  "Cross Street",
)

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("classifyEdgesWithContext – Standard lot without lane", () => {
  it("returns 4 edges for a rectangular parcel", () => {
    const result = classifyEdgesWithContext(makeParcel(), roads(mainStreet), "100 Main Street")
    expect(result).toHaveLength(4)
  })

  it("classifies the south edge (Edge 0) as Frontage", () => {
    const result = classifyEdgesWithContext(makeParcel(), roads(mainStreet), "100 Main Street")
    // Edge 0: SW → SE, east-bound
    expect(result[0].type).toBe("Frontage")
  })

  it("classifies the north edge (Edge 2) as Rear — anti-parallel to Frontage, no adjacency", () => {
    const result = classifyEdgesWithContext(makeParcel(), roads(mainStreet), "100 Main Street")
    expect(result[2].type).toBe("Rear")
  })

  it("classifies east and west edges as Side", () => {
    const result = classifyEdgesWithContext(makeParcel(), roads(mainStreet), "100 Main Street")
    expect(result[1].type).toBe("Side")
    expect(result[3].type).toBe("Side")
  })

  it("sets Frontage roadName containing the matched street name", () => {
    const result = classifyEdgesWithContext(makeParcel(), roads(mainStreet), "100 Main Street")
    expect(result[0].roadName?.toLowerCase()).toContain("main")
  })

  it("lot type resolves to 'Standard without Lane'", () => {
    const result = classifyEdgesWithContext(makeParcel(), roads(mainStreet), "100 Main Street")
    expect(classifyLot(result)).toBe("Standard without Lane")
  })
})

describe("classifyEdgesWithContext – Standard lot with lane", () => {
  it("classifies the south edge as Frontage and the north edge as Rear Lane", () => {
    const result = classifyEdgesWithContext(makeParcel(), roads(mainStreet, backLane), "100 Main Street")
    expect(result[0].type).toBe("Frontage")
    expect(result[2].type).toBe("Rear Lane")
  })

  it("classifies side edges as Side", () => {
    const result = classifyEdgesWithContext(makeParcel(), roads(mainStreet, backLane), "100 Main Street")
    expect(result[1].type).toBe("Side")
    expect(result[3].type).toBe("Side")
  })

  it("does not classify the Rear Lane edge as Frontage or Flankage", () => {
    const result = classifyEdgesWithContext(makeParcel(), roads(mainStreet, backLane), "100 Main Street")
    const rearLane = result.find((e) => e.type === "Rear Lane")
    expect(rearLane?.type).not.toBe("Frontage")
    expect(rearLane?.type).not.toBe("Flankage")
  })

  it("lot type resolves to 'Standard with Lane'", () => {
    const result = classifyEdgesWithContext(makeParcel(), roads(mainStreet, backLane), "100 Main Street")
    expect(classifyLot(result)).toBe("Standard with Lane")
  })
})

describe("classifyEdgesWithContext – Corner lot", () => {
  it("classifies the south edge as Frontage and the east edge as Flankage", () => {
    const result = classifyEdgesWithContext(makeParcel(), roads(mainStreet, crossStreet), "100 Main Street")
    expect(result[0].type).toBe("Frontage")
    expect(result[1].type).toBe("Flankage")
  })

  it("classifies the west edge as Side (not Flankage — too far from cross street)", () => {
    const result = classifyEdgesWithContext(makeParcel(), roads(mainStreet, crossStreet), "100 Main Street")
    expect(result[3].type).toBe("Side")
  })

  it("lot type resolves to 'Corner Lot'", () => {
    const result = classifyEdgesWithContext(makeParcel(), roads(mainStreet, crossStreet), "100 Main Street")
    expect(classifyLot(result)).toBe("Corner Lot")
  })

  it("Corner Lot + Lane: all three edge types coexist and lot type is still Corner Lot", () => {
    const result = classifyEdgesWithContext(
      makeParcel(),
      roads(mainStreet, crossStreet, backLane),
      "100 Main Street",
    )
    expect(result.some((e) => e.type === "Frontage")).toBe(true)
    expect(result.some((e) => e.type === "Flankage")).toBe(true)
    expect(result.some((e) => e.type === "Rear Lane")).toBe(true)
    expect(classifyLot(result)).toBe("Corner Lot")
  })
})

describe("classifyEdgesWithContext – edge cases", () => {
  it("returns only Side/Rear edges when no roads are provided", () => {
    const result = classifyEdgesWithContext(makeParcel(), roads(), "100 Main Street")
    expect(result.every((e) => e.type === "Side" || e.type === "Rear")).toBe(true)
    expect(result.some((e) => e.type === "Frontage")).toBe(false)
    expect(result.some((e) => e.type === "Flankage")).toBe(false)
    expect(result.some((e) => e.type === "Rear Lane")).toBe(false)
  })

  it("still classifies Frontage when address has no matching street (fallback to nearest road)", () => {
    const result = classifyEdgesWithContext(makeParcel(), roads(mainStreet), "999 Unknown Blvd")
    // No primary match → falls back to anyStreetEdges → south edge becomes Frontage
    expect(result.some((e) => e.type === "Frontage")).toBe(true)
  })

  it("handles 'Main St' address abbreviation the same as 'Main Street'", () => {
    const withFull = classifyEdgesWithContext(makeParcel(), roads(mainStreet), "100 Main Street")
    const withAbbr = classifyEdgesWithContext(makeParcel(), roads(mainStreet), "100 Main St")
    // Both should produce the same edge classification
    expect(withFull.map((e) => e.type)).toEqual(withAbbr.map((e) => e.type))
  })

  it("returns 4 edges for a rectangular parcel (vertex count minus closing duplicate)", () => {
    const result = classifyEdgesWithContext(makeParcel(), roads(mainStreet), "100 Main Street")
    expect(result).toHaveLength(4)
  })

  it("returns 5 edges for a pentagon-shaped parcel", () => {
    const pentagon: ParcelFeature = {
      type: "Feature",
      geometry: {
        type: "Polygon",
        coordinates: [[
          [W, S], [E, S], [E, (S + N) / 2], [(W + E) / 2, N], [W, N], [W, S],
        ]],
      },
      properties: {},
    }
    const result = classifyEdgesWithContext(pentagon, roads(mainStreet), "100 Main Street")
    expect(result).toHaveLength(5)
  })

  it("handles MultiPolygon by using the first ring of the first polygon", () => {
    const mpParcel: ParcelFeature = {
      type: "Feature",
      geometry: {
        type: "MultiPolygon",
        coordinates: [
          [[[W, S], [E, S], [E, N], [W, N], [W, S]]],
          [[[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]]],  // ignored
        ],
      },
      properties: {},
    }
    const result = classifyEdgesWithContext(mpParcel, roads(mainStreet), "100 Main Street")
    expect(result).toHaveLength(4)
    expect(result.some((e) => e.type === "Frontage")).toBe(true)
  })

  it("returns empty array for a degenerate parcel with one vertex", () => {
    const bad: ParcelFeature = {
      type: "Feature",
      geometry: {
        type: "Polygon",
        coordinates: [[[W, S]]],
      },
      properties: {},
    }
    const result = classifyEdgesWithContext(bad, roads(mainStreet), "100 Main Street")
    expect(result).toHaveLength(0)
  })

  it("Rear Lane edge is only detected on the exterior side of a wide parcel", () => {
    // backLane is north of the parcel → only the north edge (Edge 2) should be Rear Lane
    const result = classifyEdgesWithContext(makeParcel(), roads(mainStreet, backLane), "100 Main Street")
    const rearLaneEdges = result.filter((e) => e.type === "Rear Lane")
    expect(rearLaneEdges).toHaveLength(1)
    // The rear lane edge should be the north edge (index 2)
    expect(result[2].type).toBe("Rear Lane")
  })
})
