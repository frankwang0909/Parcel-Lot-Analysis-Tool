import { create } from "zustand"
import type { Map } from "mapbox-gl"
import type { RoadsCollection, ClassifiedEdge, ParcelFeature } from "./utils/geoAnalysis"

interface ParcelState {
  selectedParcel: ParcelFeature | null
  hasUserSelection: boolean
  edges: ClassifiedEdge[]
  lotType: string | null
  debug: boolean
  map: Map | null
  roads: RoadsCollection | null
  setSelectedParcel: (p: ParcelFeature | null) => void
  setHasUserSelection: (v: boolean) => void
  setEdges: (e: ClassifiedEdge[]) => void
  setLotType: (t: string) => void
  toggleDebug: () => void
  setMap: (m: Map) => void
  setRoads: (r: RoadsCollection) => void
}

export const useParcelStore = create<ParcelState>((set) => ({
  selectedParcel: null,
  hasUserSelection: false,
  edges: [],
  lotType: null,
  debug: false,
  map: null,
  roads: null,
  setSelectedParcel: (p) => set({ selectedParcel: p }),
  setHasUserSelection: (v) => set({ hasUserSelection: v }),
  setEdges: (e) => set({ edges: e }),
  setLotType: (t) => set({ lotType: t }),
  toggleDebug: () => set((s) => ({ debug: !s.debug })),
  setMap: (m) => set({ map: m }),
  setRoads: (r) => set({ roads: r }),
}))
