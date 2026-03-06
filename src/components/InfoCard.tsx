import { useParcelStore } from "../store"
import { area } from "@turf/turf"

const EDGE_COLORS: Record<string, string> = {
  Frontage: "red",
  Flankage: "orange",
  Rear: "blue",
  "Rear Lane": "green",
  Side: "gray",
}

function toTitleCase(str: string): string {
  return str
    .toLowerCase()
    .split(' ')
    .map(word => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ')
}

export default function InfoCard() {
  const { selectedParcel, hasUserSelection, lotType, edges } = useParcelStore()

  if (!hasUserSelection || !selectedParcel) return null

  const parcelArea = area(selectedParcel).toFixed(2)
  const props = selectedParcel.properties

  const frontageEdge = edges.find((e) => e.type === "Frontage")
  const primaryStreet = frontageEdge?.roadName
    ? toTitleCase(frontageEdge.roadName)
    : props?.streetname
      ? toTitleCase(props.streetname)
      : "N/A"

  const fullAddress = props?.full_address
    ? toTitleCase(props.full_address)
    : props?.civic_number != null && props?.streetname
      ? toTitleCase(`${props.civic_number} ${props.streetname}`)
      : "Unknown Address"

  const edgeTypeCounts = edges.reduce<Record<string, number>>((acc, e) => {
    acc[e.type] = (acc[e.type] ?? 0) + 1
    return acc
  }, {})

  return (
    <div style={{ position: "absolute", top: 20, right: 20, background: "white", padding: 16, borderRadius: 8, boxShadow: "0 2px 8px rgba(0,0,0,0.15)", minWidth: 220 }}>
      <h3 style={{ margin: "0 0 12px 0", fontSize: 14 }}>{fullAddress}</h3>
      <p style={{ margin: "4px 0", fontSize: 13 }}><strong>Area (m²):</strong> {parcelArea}</p>
      <p style={{ margin: "4px 0", fontSize: 13 }}><strong>Primary Street:</strong> {primaryStreet}</p>
      <p style={{ margin: "4px 0", fontSize: 13 }}><strong>Lot Type:</strong> {lotType || "N/A"}</p>
      {edges.length > 0 && (
        <div style={{ marginTop: 10, borderTop: "1px solid #eee", paddingTop: 8 }}>
          <p style={{ margin: "0 0 6px 0", fontSize: 12, fontWeight: "bold", color: "#555" }}>Edge Legend</p>
          {Object.entries(EDGE_COLORS).map(([type, color]) => {
            const count = edgeTypeCounts[type]
            if (!count) return null
            return (
              <div key={type} style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 3 }}>
                <span style={{ display: "inline-block", width: 14, height: 14, borderRadius: 2, background: color, flexShrink: 0 }} />
                <span style={{ fontSize: 12 }}>{type} <span style={{ color: "#888" }}>×{count}</span></span>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
