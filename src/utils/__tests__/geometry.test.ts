import { describe, it, expect } from "vitest"
import { lineString, polygon } from "@turf/turf"
import {
  edgeDirection,
  dotProduct,
  calculateAngleBetweenLines,
  extractEdges,
} from "../geometry"

describe("edgeDirection", () => {
  it("returns correct direction for a 2-point LineString", () => {
    const edge = lineString([[0, 0], [1, 0]])
    const dir = edgeDirection(edge)
    expect(dir.dx).toBe(1)
    expect(dir.dy).toBe(0)
  })

  it("uses first and last coords (not first two) for a multi-node LineString", () => {
    // If first-two were used: dx=0.5, dy=5
    // If first/last are used: dx=2, dy=0
    const edge = lineString([[0, 0], [0.5, 5], [2, 0]])
    const dir = edgeDirection(edge)
    expect(dir.dx).toBe(2)
    expect(dir.dy).toBe(0)
  })

  it("returns correct direction for a diagonal edge", () => {
    const edge = lineString([[0, 0], [3, 4]])
    expect(edgeDirection(edge)).toEqual({ dx: 3, dy: 4 })
  })

  it("returns a negative direction for a west-pointing edge", () => {
    const edge = lineString([[5, 0], [0, 0]])
    expect(edgeDirection(edge)).toEqual({ dx: -5, dy: 0 })
  })
})

describe("dotProduct", () => {
  it("returns 1 for identical unit vectors", () => {
    expect(dotProduct({ dx: 1, dy: 0 }, { dx: 1, dy: 0 })).toBe(1)
  })

  it("returns -1 for anti-parallel unit vectors", () => {
    expect(dotProduct({ dx: 1, dy: 0 }, { dx: -1, dy: 0 })).toBe(-1)
  })

  it("returns 0 for perpendicular vectors", () => {
    expect(dotProduct({ dx: 1, dy: 0 }, { dx: 0, dy: 1 })).toBe(0)
  })

  it("computes dot product correctly for arbitrary vectors", () => {
    // (2,3)·(4,5) = 8+15 = 23
    expect(dotProduct({ dx: 2, dy: 3 }, { dx: 4, dy: 5 })).toBe(23)
  })
})

describe("calculateAngleBetweenLines", () => {
  it("returns 0 for parallel lines", () => {
    const a = lineString([[0, 0], [1, 0]])
    const b = lineString([[0, 1], [2, 1]])
    expect(calculateAngleBetweenLines(a, b)).toBeCloseTo(0, 5)
  })

  it("returns 0 for anti-parallel lines (folds to acute angle)", () => {
    const a = lineString([[0, 0], [1, 0]])
    const b = lineString([[2, 0], [0, 0]]) // reversed
    expect(calculateAngleBetweenLines(a, b)).toBeCloseTo(0, 5)
  })

  it("returns 90 for perpendicular lines", () => {
    const a = lineString([[0, 0], [1, 0]])
    const b = lineString([[0, 0], [0, 1]])
    expect(calculateAngleBetweenLines(a, b)).toBeCloseTo(90, 5)
  })

  it("returns 45 for a 45-degree pair", () => {
    const a = lineString([[0, 0], [1, 0]])
    const b = lineString([[0, 0], [1, 1]])
    expect(calculateAngleBetweenLines(a, b)).toBeCloseTo(45, 5)
  })

  it("returns 0 for zero-length lines", () => {
    const a = lineString([[0, 0], [0, 0]])
    const b = lineString([[1, 0], [2, 0]])
    expect(calculateAngleBetweenLines(a, b)).toBe(0)
  })
})

describe("extractEdges", () => {
  it("extracts 4 edges from a rectangular polygon (5 coords including closing)", () => {
    const poly = polygon([[[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]]])
    expect(extractEdges(poly)).toHaveLength(4)
  })

  it("each extracted edge has exactly 2 coordinates", () => {
    const poly = polygon([[[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]]])
    for (const edge of extractEdges(poly)) {
      expect(edge.geometry.coordinates).toHaveLength(2)
    }
  })

  it("preserves vertex order across edges", () => {
    const poly = polygon([[[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]]])
    const edges = extractEdges(poly)
    expect(edges[0].geometry.coordinates).toEqual([[0, 0], [1, 0]])
    expect(edges[1].geometry.coordinates).toEqual([[1, 0], [1, 1]])
    expect(edges[2].geometry.coordinates).toEqual([[1, 1], [0, 1]])
    expect(edges[3].geometry.coordinates).toEqual([[0, 1], [0, 0]])
  })

  it("consecutive edges share a vertex (polygon is closed)", () => {
    const poly = polygon([[[0, 0], [2, 0], [2, 3], [0, 3], [0, 0]]])
    const edges = extractEdges(poly)
    for (let i = 0; i < edges.length - 1; i++) {
      const endOfCurrent = edges[i].geometry.coordinates[1]
      const startOfNext = edges[i + 1].geometry.coordinates[0]
      expect(endOfCurrent).toEqual(startOfNext)
    }
  })
})
