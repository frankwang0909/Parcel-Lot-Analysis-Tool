import type { ClassifiedEdge } from "./geoAnalysis"
import { edgeDirection, dotProduct } from "./geometry"

export function classifyLot(classifiedEdges: ClassifiedEdge[]) {
  const frontageEdges = classifiedEdges.filter((e) => e.type === "Frontage")
  const roadNames = new Set(frontageEdges.map((e) => e.roadName || ""))
  const flankageNames = new Set(
    classifiedEdges
      .filter((e) => e.type === "Flankage")
      .map((e) => e.roadName || "")
  )

  // Standard with Lane requires a Rear Lane edge that is anti-parallel to the Frontage
  const rearLaneOppositesFrontage = classifiedEdges
    .filter((e) => e.type === "Rear Lane")
    .some((rearLane) =>
      frontageEdges.some((frontage) => {
        const fDir = edgeDirection(frontage.edge)
        const rDir = edgeDirection(rearLane.edge)
        const fLen = Math.hypot(fDir.dx, fDir.dy)
        const rLen = Math.hypot(rDir.dx, rDir.dy)
        if (fLen === 0 || rLen === 0) return false
        const cosine = dotProduct(
          { dx: fDir.dx / fLen, dy: fDir.dy / fLen },
          { dx: rDir.dx / rLen, dy: rDir.dy / rLen }
        )
        return cosine < -0.65
      })
    )

  if (roadNames.size >= 1 && flankageNames.size >= 1) return "Corner Lot"
  if (roadNames.size >= 2) return "Double Fronting"
  if (roadNames.size === 1 && rearLaneOppositesFrontage) return "Standard with Lane"

  return "Standard without Lane"
}
