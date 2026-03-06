import { useCallback, useEffect, useRef, useState } from "react"
import mapboxgl from "mapbox-gl"
import { point, booleanPointInPolygon, area, polygonToLine, lineString, pointToLineDistance } from "@turf/turf"
import { useParcelStore } from "../store"
import { edgeMidpoint } from "../utils/geometry"
import { classifyLot } from "../utils/classification"
import {
  classifyEdgesWithContext,
  type ClassifiedEdge,
  type ParcelFeature,
  type ParcelProperties,
  type RoadsCollection,
} from "../utils/geoAnalysis"
import SearchBar from "./SearchBar"

mapboxgl.accessToken = import.meta.env.VITE_MAPBOX_TOKEN

const EDGE_COLORS: Record<string, string> = {
  Frontage: "red",
  Flankage: "orange",
  Rear: "blue",
  "Rear Lane": "green",
  Side: "gray",
}

const MIN_PARCEL_ZOOM = 15
const PARCEL_ZOOM_EPSILON = 0.05
const PARCEL_BOUNDS_BUFFER_RATIO = 1.2
const PARCEL_BROWSER_CACHE = "unlockland-parcels-v1"
const PARCEL_BBOX_GRID_STEP = 0.01   // ~1.1km grid — snaps bbox to fixed cells for high cache hit rate
const MAX_PARCEL_CACHE_KEYS = 64
const SEARCH_PARCEL_RETRY_TIMEOUT_MS = 20000
const ROAD_NAME_PROPERTY_KEYS = [
  "name",
  "name_en",
  "name:en",
  "name_zh",
  "name_zh-Hans",
  "name_zh-Hant",
]

function metersToPixelsAtZoom(meters: number, latitude: number, zoom: number): number {
  const metersPerPixel =
    (156543.03392 * Math.cos((latitude * Math.PI) / 180)) / Math.pow(2, zoom)
  return metersPerPixel > 0 ? meters / metersPerPixel : meters
}

export default function MapView() {
  const mapRef = useRef<mapboxgl.Map | null>(null)
  const { setSelectedParcel, setHasUserSelection, setEdges, setLotType, setMap, setRoads } = useParcelStore()
  const selectionVersionRef = useRef(0)
  const isParcelLoadingRef = useRef(false)
  const [isParcelLoading, setIsParcelLoading] = useState(false)
  const [parcelHint, setParcelHint] = useState<string>("")
  const parcelCacheRef = useRef<Map<string, GeoJSON.FeatureCollection>>(new Map())
  const loadedParcelsRef = useRef<GeoJSON.FeatureCollection>({
    type: "FeatureCollection",
    features: [],
  })
  const parcelsFetchStateRef = useRef<{
    timeoutId: ReturnType<typeof setTimeout> | null
    lastBboxKey: string | null
    abortController: AbortController | null
    loadedBounds: mapboxgl.LngLatBounds | null
    pendingCallbacks: Array<() => void>
  }>({
    timeoutId: null,
    lastBboxKey: null,
    abortController: null,
    loadedBounds: null,
    pendingCallbacks: [],
  })

  const renderClassifiedEdges = useCallback((
    map: mapboxgl.Map,
    classified: ClassifiedEdge[]
  ) => {
    setEdges(classified)

    const edgeFeatures: GeoJSON.Feature<GeoJSON.LineString>[] = classified.map(
      (item: ClassifiedEdge) => ({
        type: "Feature" as const,
        properties: {
          edgeType: item.type,
          color: EDGE_COLORS[item.type] || "#ffffff",
        },
        geometry: {
          type: "LineString" as const,
          coordinates: item.edge.geometry.coordinates,
        },
      })
    )

    const edgePointFeatures: GeoJSON.Feature<GeoJSON.Point>[] = classified.map(
      (item: ClassifiedEdge) => ({
        type: "Feature" as const,
        properties: {
          edgeType: item.type,
          color: EDGE_COLORS[item.type] || "#ffffff",
          label: item.type,
        },
        geometry: {
          type: "Point" as const,
          coordinates: edgeMidpoint(item.edge).geometry.coordinates,
        },
      })
    )

    const edgeSource = map.getSource("edge-lines") as mapboxgl.GeoJSONSource
    edgeSource.setData({
      type: "FeatureCollection",
      features: edgeFeatures,
    })

    const edgePointSource = map.getSource("edge-points") as mapboxgl.GeoJSONSource
    edgePointSource.setData({
      type: "FeatureCollection",
      features: edgePointFeatures,
    })

    const lotType = classifyLot(classified)
    setLotType(lotType)
  }, [setEdges, setLotType])

  const clearEdgeOverlays = useCallback((map: mapboxgl.Map) => {
    setEdges([])
    setLotType("")

    const emptyCollection: GeoJSON.FeatureCollection = {
      type: "FeatureCollection",
      features: [],
    }

    const edgeSource = map.getSource("edge-lines") as mapboxgl.GeoJSONSource | undefined
    edgeSource?.setData(emptyCollection)

    const edgePointSource = map.getSource("edge-points") as mapboxgl.GeoJSONSource | undefined
    edgePointSource?.setData(emptyCollection)
  }, [setEdges, setLotType])

  const clearSelection = useCallback((map: mapboxgl.Map) => {
    selectionVersionRef.current += 1
    clearEdgeOverlays(map)
    setHasUserSelection(false)
    setSelectedParcel(null)
    setRoads({
      type: "FeatureCollection",
      features: [],
    })

    const source = map.getSource("selected-parcel") as mapboxgl.GeoJSONSource | undefined
    source?.setData({
      type: "FeatureCollection",
      features: [],
    })
  }, [clearEdgeOverlays, setHasUserSelection, setRoads, setSelectedParcel])

  const buildParcelUrl = useCallback((bboxKey: string) =>
    `https://opendata.vancouver.ca/api/explore/v2.1/catalog/datasets/property-parcel-polygons/exports/geojson?bbox=${bboxKey}`
  , [])

  const fetchParcelsWithCache = useCallback(async (
    url: string,
    signal: AbortSignal
  ): Promise<{ data: GeoJSON.FeatureCollection; fromCache: boolean }> => {
    const supportsCacheApi =
      typeof window !== "undefined" && typeof window.caches !== "undefined"

    if (supportsCacheApi) {
      try {
        const cache = await window.caches.open(PARCEL_BROWSER_CACHE)
        const cachedResponse = await cache.match(url)
        if (cachedResponse) {
          const data = (await cachedResponse.json()) as GeoJSON.FeatureCollection
          return { data, fromCache: true }
        }
      } catch (error) {
        void error
      }
    }

    const networkResponse = await fetch(url, { signal })
    const data = (await networkResponse.json()) as GeoJSON.FeatureCollection

    if (supportsCacheApi) {
      try {
        const cache = await window.caches.open(PARCEL_BROWSER_CACHE)
        await cache.put(url, new Response(JSON.stringify(data)))
      } catch (error) {
        void error
      }
    }

    return { data, fromCache: false }
  }, [])

  const getRoadLayerIds = useCallback((map: mapboxgl.Map): string[] => {
    const layers = map.getStyle().layers || []
    return layers
      .filter((layer) => {
        if (layer.type !== "line") return false
        const id = layer.id.toLowerCase()
        return (
          id.includes("road") ||
          id.includes("service") ||
          id.includes("lane") ||
          id.includes("alley")
        )
      })
      .map((layer) => layer.id)
  }, [])

  const turfBboxFromParcel = useCallback((parcel: ParcelFeature): GeoJSON.BBox => {
    const coords =
      parcel.geometry.type === "Polygon"
        ? parcel.geometry.coordinates[0]
        : parcel.geometry.coordinates[0][0]
    let minX = Infinity
    let minY = Infinity
    let maxX = -Infinity
    let maxY = -Infinity
    for (const [x, y] of coords) {
      if (x < minX) minX = x
      if (y < minY) minY = y
      if (x > maxX) maxX = x
      if (y > maxY) maxY = y
    }
    return [minX, minY, maxX, maxY]
  }, [])

  const getBasemapRoadsForParcel = useCallback((
    map: mapboxgl.Map,
    parcel: ParcelFeature
  ): RoadsCollection => {
    const roadLayerIds = getRoadLayerIds(map)
    if (roadLayerIds.length === 0) {
      return { type: "FeatureCollection", features: [] }
    }

    const bbox = turfBboxFromParcel(parcel)
    const sw = map.project([bbox[0], bbox[1]])
    const ne = map.project([bbox[2], bbox[3]])
    const centerLat = (bbox[1] + bbox[3]) / 2
    const dynamicPad = metersToPixelsAtZoom(90, centerLat, map.getZoom())
    const pad = Math.max(36, dynamicPad)
    const minX = Math.min(sw.x, ne.x) - pad
    const maxX = Math.max(sw.x, ne.x) + pad
    const minY = Math.min(sw.y, ne.y) - pad
    const maxY = Math.max(sw.y, ne.y) + pad
    let features = map.queryRenderedFeatures(
      [
        [minX, minY],
        [maxX, maxY],
      ],
      { layers: roadLayerIds }
    )
    if (features.length === 0) {
      const retryPad = pad * 1.8
      features = map.queryRenderedFeatures(
        [
          [minX - retryPad, minY - retryPad],
          [maxX + retryPad, maxY + retryPad],
        ],
        { layers: roadLayerIds }
      )
    }

    const seen = new Set<string>()
    const roads: RoadsCollection["features"] = []

    for (const f of features) {
      const geometry = f.geometry as GeoJSON.Geometry | null
      if (!geometry) continue
      if (geometry.type !== "LineString" && geometry.type !== "MultiLineString") continue

      const props = (f.properties || {}) as Record<string, unknown>
      const roadName = ROAD_NAME_PROPERTY_KEYS
        .map((key) => props[key])
        .find((value): value is string => typeof value === "string" && value.trim().length > 0) ?? ""

      const roadClass =
        String(props.class || props.road_class || props.type || "")

      // Keep named roads, and also keep unnamed roads that look like lanes/alleys
      if (!roadName) {
        const cls = roadClass.toLowerCase()
        const isUnnamedLane = cls === "lane" || cls === "alley" || cls === "service" || cls.includes("lane") || cls.includes("alley")
        if (!isUnnamedLane) continue
      }

      const dedupeKey = `${f.layer?.id || ""}|${roadName}|${JSON.stringify(geometry)}`
      if (seen.has(dedupeKey)) continue
      seen.add(dedupeKey)

      roads.push({
        type: "Feature",
        geometry: geometry as GeoJSON.LineString | GeoJSON.MultiLineString,
        properties: {
          ...props,
          name: roadName,
          class: roadClass,
          source_dataset: "mapbox-streets",
        },
      })
    }

    return {
      type: "FeatureCollection",
      features: roads,
    }
  }, [getRoadLayerIds, turfBboxFromParcel])

  const pickParcelAtPoint = useCallback((lng: number, lat: number) => {
    const clickPoint = point([lng, lat])
    const parcels = loadedParcelsRef.current.features
    const polygonParcels = parcels.filter((feature) =>
      feature.geometry?.type === "Polygon" || feature.geometry?.type === "MultiPolygon"
    ) as Array<GeoJSON.Feature<GeoJSON.Polygon | GeoJSON.MultiPolygon>>

    if (polygonParcels.length === 0) return null

    const containing = polygonParcels.filter((feature) => booleanPointInPolygon(clickPoint, feature))
    if (containing.length > 0) {
      const smallest = containing
        .slice()
        .sort((a, b) => area(a) - area(b))[0]
      return smallest as unknown as mapboxgl.MapboxGeoJSONFeature
    }

    let nearest: GeoJSON.Feature<GeoJSON.Polygon | GeoJSON.MultiPolygon> | null = null
    let minDistance = Infinity
    for (const feature of polygonParcels) {
      const outline = polygonToLine(feature)
      const outlineLines: GeoJSON.Feature<GeoJSON.LineString>[] = []

      const collectLineFeature = (lineFeature: GeoJSON.Feature<GeoJSON.LineString | GeoJSON.MultiLineString>) => {
        if (lineFeature.geometry.type === "LineString") {
          outlineLines.push(lineFeature as GeoJSON.Feature<GeoJSON.LineString>)
          return
        }
        for (const coords of lineFeature.geometry.coordinates) {
          outlineLines.push(lineString(coords))
        }
      }

      if (outline.type === "FeatureCollection") {
        for (const lineFeature of outline.features) {
          collectLineFeature(lineFeature as GeoJSON.Feature<GeoJSON.LineString | GeoJSON.MultiLineString>)
        }
      } else {
        collectLineFeature(outline as GeoJSON.Feature<GeoJSON.LineString | GeoJSON.MultiLineString>)
      }

      const distance = outlineLines.reduce((best, line) => {
        const d = pointToLineDistance(clickPoint, line, { units: "meters" })
        return d < best ? d : best
      }, Infinity)
      if (distance < minDistance) {
        minDistance = distance
        nearest = feature
      }
    }

    if (!nearest || minDistance > 25) return null
    return nearest as unknown as mapboxgl.MapboxGeoJSONFeature
  }, [])

  const analyzeParcelFeature = useCallback(async (
    map: mapboxgl.Map,
    feature: mapboxgl.MapboxGeoJSONFeature
  ) => {
    const selectionVersion = ++selectionVersionRef.current
    clearEdgeOverlays(map)
    setHasUserSelection(true)
    setSelectedParcel(feature as GeoJSON.Feature<GeoJSON.Polygon | GeoJSON.MultiPolygon, ParcelProperties>)

    const source = map.getSource("selected-parcel") as mapboxgl.GeoJSONSource
    source.setData({
      type: "FeatureCollection",
      features: [],
    })
    source.setData({
      type: "FeatureCollection",
      features: [feature],
    })

    await new Promise<void>((resolve) => {
      window.requestAnimationFrame(() => resolve())
    })
    if (selectionVersion !== selectionVersionRef.current) return

    await new Promise<void>((resolve) => {
      let settled = false
      const timer = window.setTimeout(() => {
        if (settled) return
        settled = true
        resolve()
      }, 1200)

      map.once("idle", () => {
        if (settled) return
        settled = true
        window.clearTimeout(timer)
        resolve()
      })
    })
    if (selectionVersion !== selectionVersionRef.current) return

    if (!feature.properties) return

    const addressForMatching = `${feature.properties.civic_number || ""} ${feature.properties.streetname || ""}`.trim()
    const parcelFeature = feature as unknown as ParcelFeature
    const roads = getBasemapRoadsForParcel(map, parcelFeature)
    setRoads(roads)
    const classified = classifyEdgesWithContext(parcelFeature, roads, addressForMatching)
    if (selectionVersion !== selectionVersionRef.current) return

    renderClassifiedEdges(map, classified)
  }, [clearEdgeOverlays, getBasemapRoadsForParcel, renderClassifiedEdges, setHasUserSelection, setRoads, setSelectedParcel])

  useEffect(() => {
    isParcelLoadingRef.current = isParcelLoading
  }, [isParcelLoading])
  
  useEffect(() => {
    setHasUserSelection(false)
    const fetchState = parcelsFetchStateRef.current
    const map = new mapboxgl.Map({
      container: "map",
      style: "mapbox://styles/mapbox/streets-v11",
      center: [-123.1207, 49.2827],
      zoom: 15,
    })

    mapRef.current = map

    map.on("load", () => {
      setMap(map)

      map.addSource("parcels", {
        type: "geojson",
        data: {
          type: "FeatureCollection",
          features: [],
        },
      })

      map.addLayer({
        id: "parcel-fill",
        type: "fill",
        source: "parcels",
        paint: {
          "fill-color": "#888",
          "fill-opacity": 0.4,
        },
      })

      map.addSource("selected-parcel", {
        type: "geojson",
        data: {
          type: "FeatureCollection",
          features: [],
        },
      })

      map.addLayer({
        id: "selected-parcel-fill",
        type: "fill",
        source: "selected-parcel",
        paint: {
          "fill-color": "#ffeb3b",
          "fill-opacity": 0.5,
        },
      })

      map.addLayer({
        id: "selected-parcel-outline",
        type: "line",
        source: "selected-parcel",
        paint: {
          "line-color": "#f59e0b",
          "line-width": 2.5,
          "line-opacity": 1,
        },
      })

      map.addSource("edge-lines", {
        type: "geojson",
        data: {
          type: "FeatureCollection",
          features: [],
        },
      })

      map.addLayer({
        id: "edge-lines",
        type: "line",
        source: "edge-lines",
        layout: { "line-cap": "round", "line-join": "round" },
        paint: {
          "line-color": ["get", "color"],
          "line-width": 4,
          "line-opacity": 0.95,
        },
      })

      map.addSource("edge-points", {
        type: "geojson",
        data: {
          type: "FeatureCollection",
          features: [],
        },
      })

      map.addLayer({
        id: "edge-points",
        type: "circle",
        source: "edge-points",
        paint: {
          "circle-color": ["get", "color"],
          "circle-radius": 4,
          "circle-opacity": 0.9,
        },
      })

      map.addLayer({
        id: "edge-labels",
        type: "symbol",
        source: "edge-points",
        layout: {
          "text-field": ["get", "label"],
          "text-size": 12,
          "text-offset": [0, 0.8],
          "text-anchor": "top",
        },
        paint: {
          "text-color": "#111",
          "text-halo-color": "#fff",
          "text-halo-width": 1,
        },
      })

      const drainParcelCallbacks = () => {
        const cbs = fetchState.pendingCallbacks.splice(0)
        cbs.forEach((cb) => cb())
      }

      const updateParcelsForViewport = async () => {
        const parcelsSource = map.getSource("parcels") as mapboxgl.GeoJSONSource

        if (map.getZoom() + PARCEL_ZOOM_EPSILON < MIN_PARCEL_ZOOM) {
          parcelsSource.setData({
            type: "FeatureCollection",
            features: [],
          })
          loadedParcelsRef.current = {
            type: "FeatureCollection",
            features: [],
          }
          fetchState.lastBboxKey = null
          fetchState.loadedBounds = null
          if (fetchState.abortController) {
            fetchState.abortController.abort()
            fetchState.abortController = null
          }
          setIsParcelLoading(false)
          setParcelHint("")
          drainParcelCallbacks()
          return
        }

        setParcelHint("")

        const bounds = map.getBounds()
        if (!bounds) {
          drainParcelCallbacks()
          return
        }

        if (fetchState.loadedBounds) {
          const loaded = fetchState.loadedBounds
          const fullyCovered =
            loaded.getWest() <= bounds.getWest() &&
            loaded.getSouth() <= bounds.getSouth() &&
            loaded.getEast() >= bounds.getEast() &&
            loaded.getNorth() >= bounds.getNorth()
          if (fullyCovered) {
            drainParcelCallbacks()
            return
          }
        }

        const lngSpan = bounds.getEast() - bounds.getWest()
        const latSpan = bounds.getNorth() - bounds.getSouth()
        const bufferedBounds: GeoJSON.BBox = [
          bounds.getWest() - lngSpan * PARCEL_BOUNDS_BUFFER_RATIO,
          bounds.getSouth() - latSpan * PARCEL_BOUNDS_BUFFER_RATIO,
          bounds.getEast() + lngSpan * PARCEL_BOUNDS_BUFFER_RATIO,
          bounds.getNorth() + latSpan * PARCEL_BOUNDS_BUFFER_RATIO,
        ]

        const snapDown = (v: number) => Math.floor(v / PARCEL_BBOX_GRID_STEP) * PARCEL_BBOX_GRID_STEP
        const snapUp = (v: number) => Math.ceil(v / PARCEL_BBOX_GRID_STEP) * PARCEL_BBOX_GRID_STEP
        const bboxParts = [
          parseFloat(snapDown(bufferedBounds[0]).toFixed(4)),
          parseFloat(snapDown(bufferedBounds[1]).toFixed(4)),
          parseFloat(snapUp(bufferedBounds[2]).toFixed(4)),
          parseFloat(snapUp(bufferedBounds[3]).toFixed(4)),
        ]
        const bboxKey = bboxParts.join(",")

        if (fetchState.lastBboxKey === bboxKey) {
          drainParcelCallbacks()
          return
        }

        const cached = parcelCacheRef.current.get(bboxKey)
        if (cached) {
          parcelsSource.setData(cached)
          loadedParcelsRef.current = cached
          fetchState.lastBboxKey = bboxKey
          fetchState.loadedBounds = new mapboxgl.LngLatBounds(
            [bboxParts[0], bboxParts[1]],
            [bboxParts[2], bboxParts[3]]
          )
          drainParcelCallbacks()
          return
        }

        if (fetchState.timeoutId) {
          clearTimeout(fetchState.timeoutId)
        }

        fetchState.timeoutId = setTimeout(async () => {
          if (fetchState.abortController) {
            fetchState.abortController.abort()
          }

          const controller = new AbortController()
          fetchState.abortController = controller

          const url = buildParcelUrl(bboxKey)

          let loadingIndicatorId = 0
          try {
            loadingIndicatorId = window.setTimeout(() => {
              setIsParcelLoading(true)
              setParcelHint("Loading data...")
            }, 300)
            const { data: parcels, fromCache } = await fetchParcelsWithCache(
              url,
              controller.signal
            )

            if (controller.signal.aborted) {
              window.clearTimeout(loadingIndicatorId)
              return
            }

            window.clearTimeout(loadingIndicatorId)
            parcelsSource.setData(parcels)
            loadedParcelsRef.current = parcels
            parcelCacheRef.current.set(bboxKey, parcels)
            if (parcelCacheRef.current.size > MAX_PARCEL_CACHE_KEYS) {
              const oldestKey = parcelCacheRef.current.keys().next().value as string | undefined
              if (oldestKey) parcelCacheRef.current.delete(oldestKey)
            }
            fetchState.lastBboxKey = bboxKey
            fetchState.loadedBounds = new mapboxgl.LngLatBounds(
              [bboxParts[0], bboxParts[1]],
              [bboxParts[2], bboxParts[3]]
            )
            void fromCache
            setParcelHint("")
            drainParcelCallbacks()

            // Silently pre-fetch adjacent grid cells so panning hits cache immediately
            const [w, s, e, n] = bboxParts
            const bboxWidth = e - w
            const bboxHeight = n - s
            const neighbors = [
              [w, n, e, n + bboxHeight],               // North
              [w, s - bboxHeight, e, s],               // South
              [e, s, e + bboxWidth, n],                // East
              [w - bboxWidth, s, w, n],                // West
            ]
            window.setTimeout(() => {
              for (const [nw, ns, ne, nn] of neighbors) {
                const neighborKey = [
                  parseFloat(nw.toFixed(4)),
                  parseFloat(ns.toFixed(4)),
                  parseFloat(ne.toFixed(4)),
                  parseFloat(nn.toFixed(4)),
                ].join(",")
                if (parcelCacheRef.current.has(neighborKey)) continue
                void fetchParcelsWithCache(buildParcelUrl(neighborKey), new AbortController().signal)
                  .then(({ data }) => {
                    if (parcelCacheRef.current.has(neighborKey)) return
                    parcelCacheRef.current.set(neighborKey, data)
                    if (parcelCacheRef.current.size > MAX_PARCEL_CACHE_KEYS) {
                      const oldest = parcelCacheRef.current.keys().next().value as string | undefined
                      if (oldest) parcelCacheRef.current.delete(oldest)
                    }
                  })
                  .catch(() => { /* silent — prefetch is best-effort */ })
              }
            }, 1000)
          } catch (error) {
            window.clearTimeout(loadingIndicatorId)
            if ((error as Error).name === "AbortError") return
            setParcelHint("Failed to load parcels, retrying on next move")
            drainParcelCallbacks()
          } finally {
            if (fetchState.abortController === controller) {
              setIsParcelLoading(false)
            }
          }
        }, 500)
      }

      map.on("moveend", updateParcelsForViewport)
      updateParcelsForViewport()

      map.on("click", "parcel-fill", (e: mapboxgl.MapMouseEvent) => {
        void (async () => {
          if (!e.features || e.features.length === 0) return
          if (isParcelLoadingRef.current) {
            clearSelection(map)
            return
          }
          const feature = e.features[0]
          await analyzeParcelFeature(map, feature)
        })()
      })

    })
    return () => {
      if (fetchState.timeoutId) {
        clearTimeout(fetchState.timeoutId)
      }
      if (fetchState.abortController) {
        fetchState.abortController.abort()
      }
      setIsParcelLoading(false)
      map.remove()
    }
  }, [analyzeParcelFeature, clearSelection, fetchParcelsWithCache, setHasUserSelection, setMap])

  const handleSearchResult = async (result: { id: string; place_name: string; center: [number, number] }) => {
    const map = mapRef.current
    if (!map) return

    clearSelection(map)
    const requestVersion = selectionVersionRef.current

    const [lng, lat] = result.center

    map.flyTo({
      center: [lng, lat],
      zoom: 18,
      duration: 1500,
    })

    await new Promise<void>((resolve) => {
      map.once("moveend", () => resolve())
    })
    if (requestVersion !== selectionVersionRef.current) return

    const tryPickParcel = (): boolean => {
      if (requestVersion !== selectionVersionRef.current) return true
      const pickedFromSource = pickParcelAtPoint(lng, lat)
      if (pickedFromSource) {
        void analyzeParcelFeature(map, pickedFromSource)
        return true
      }
      const centerPoint = map.project([lng, lat])
      const hitRadius = 10
      const renderedFeatures = map.queryRenderedFeatures(
        [
          [centerPoint.x - hitRadius, centerPoint.y - hitRadius],
          [centerPoint.x + hitRadius, centerPoint.y + hitRadius],
        ],
        { layers: ["parcel-fill"] }
      )
      if (renderedFeatures.length > 0) {
        void analyzeParcelFeature(map, renderedFeatures[0])
        return true
      }
      return false
    }

    if (tryPickParcel()) return

    await new Promise<void>((resolve) => {
      const timeoutId = window.setTimeout(resolve, SEARCH_PARCEL_RETRY_TIMEOUT_MS)
      parcelsFetchStateRef.current.pendingCallbacks.push(() => {
        window.clearTimeout(timeoutId)
        resolve()
      })
    })

    tryPickParcel()
  }

  return (
    <>
      <SearchBar onSelectResult={handleSearchResult} />
      <div id="map" style={{ height: "100vh", width: "100vw" }} />
      {(isParcelLoading || parcelHint) && (
        <div
          style={{
            position: "fixed",
            top: 16,
            right: 16,
            background: "rgba(17, 24, 39, 0.9)",
            color: "#fff",
            padding: "8px 12px",
            borderRadius: 8,
            fontSize: 13,
            zIndex: 20,
          }}
        >
          {isParcelLoading ? "Loading data..." : parcelHint}
        </div>
      )}
    </>
  )
}
