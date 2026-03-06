import { useParcelStore } from "../store"

export default function DebugPanel() {
  const {
    debug,
    toggleDebug,
    edges,
    lotType,
    selectedParcel,
    roads,
    map,
  } = useParcelStore()

  const parcelProps = selectedParcel?.properties ?? null
  const mapCenter = map ? map.getCenter() : null
  const mapZoom = map ? map.getZoom() : null

  return (
    <div style={{ position: "absolute", bottom: 20, left: 20, zIndex: 2000 }}>
      <button onClick={toggleDebug}>
        {debug ? "Hide Debug" : "Show Debug"}
      </button>
      {debug && (
        <div
          style={{
            marginTop: 8,
            width: 380,
            maxHeight: "55vh",
            overflowY: "auto",
            background: "rgba(17, 24, 39, 0.94)",
            color: "#e5e7eb",
            padding: 12,
            borderRadius: 8,
            fontSize: 12,
            lineHeight: 1.45,
            boxShadow: "0 8px 24px rgba(0, 0, 0, 0.3)",
          }}
        >
          <div><strong>Diagnostics</strong></div>
          <div>Lot Type: {lotType || "N/A"}</div>
          <div>Edges: {edges.length}</div>
          <div>Road features loaded: {roads?.features.length ?? 0}</div>
          <div>
            Map: {mapCenter ? `${mapCenter.lng.toFixed(5)}, ${mapCenter.lat.toFixed(5)}` : "N/A"}
            {mapZoom !== null ? ` (z${mapZoom.toFixed(2)})` : ""}
          </div>

          <hr style={{ borderColor: "rgba(148, 163, 184, 0.4)" }} />
          <div><strong>Selected Parcel</strong></div>
          <div>Civic: {String(parcelProps?.civic_number ?? "N/A")}</div>
          <div>Street: {String(parcelProps?.streetname ?? "N/A")}</div>
          <div>Site ID: {String(parcelProps?.site_id ?? "N/A")}</div>
          <div>Tax Coord: {String(parcelProps?.tax_coord ?? "N/A")}</div>

          <hr style={{ borderColor: "rgba(148, 163, 184, 0.4)" }} />
          <div><strong>Edges Detail</strong></div>
          {edges.length === 0 ? (
            <div>No edge classification yet.</div>
          ) : (
            <ol style={{ margin: "6px 0 0 18px", padding: 0 }}>
              {edges.map((edge, index) => (
                <li key={`${index}-${edge.type}-${edge.roadName || "none"}`}>
                  {edge.type} | {edge.roadName || "N/A"}
                </li>
              ))}
            </ol>
          )}
        </div>
      )}
    </div>
  )
}
