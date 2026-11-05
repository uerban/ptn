import { useEffect, useRef } from "react";
import maplibregl from "../../map/maplibre.ts";
import type { LatLon } from "@pt/shared";

interface UserPositionMarkerProps {
  map: maplibregl.Map | null;
  position: LatLon | null;
  heading: number | null;
  accuracy: number | null;
  paused?: boolean;
}

function createMarkerElement(heading: number | null): HTMLDivElement {
  const el = document.createElement("div");
  el.className = "user-position-marker";
  el.style.cssText = "width:24px;height:24px;position:relative;";

  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("width", "24");
  svg.setAttribute("height", "24");
  svg.setAttribute("viewBox", "0 0 24 24");

  if (heading !== null) {
    svg.style.transform = `rotate(${heading}deg)`;
    // Cone indicator
    const cone = document.createElementNS(ns, "path");
    cone.setAttribute("d", "M12 2 L8 10 L16 10 Z");
    cone.setAttribute("fill", "#3b82f6");
    cone.setAttribute("opacity", "0.3");
    svg.appendChild(cone);
  }

  // Center dot
  const circle = document.createElementNS(ns, "circle");
  circle.setAttribute("cx", "12");
  circle.setAttribute("cy", "12");
  circle.setAttribute("r", "6");
  circle.setAttribute("fill", "#3b82f6");
  circle.setAttribute("stroke", "white");
  circle.setAttribute("stroke-width", "2");
  svg.appendChild(circle);

  el.appendChild(svg);
  return el;
}

export function UserPositionMarker({
  map,
  position,
  heading,
  accuracy,
  paused = false,
}: UserPositionMarkerProps) {
  const markerRef = useRef<maplibregl.Marker | null>(null);
  const accuracySourceRef = useRef(false);

  // Create marker once, then update position/rotation incrementally
  useEffect(() => {
    if (!map || !position) {
      if (markerRef.current) {
        markerRef.current.remove();
        markerRef.current = null;
      }
      return;
    }

    if (!markerRef.current) {
      const el = createMarkerElement(heading);
      markerRef.current = new maplibregl.Marker({
        element: el,
        anchor: "center",
      })
        .setLngLat([position.lon, position.lat])
        .addTo(map);
    } else {
      // Update position without recreating the marker
      markerRef.current.setLngLat([position.lon, position.lat]);
      // Update heading rotation on the SVG element
      const el = markerRef.current.getElement();
      const svg = el.querySelector("svg");
      if (svg) {
        svg.style.transform = heading !== null ? `rotate(${heading}deg)` : "";
      }
    }

    return () => {
      if (markerRef.current) {
        markerRef.current.remove();
        markerRef.current = null;
      }
    };
  }, [map, position, heading]);

  useEffect(() => {
    markerRef.current?.getElement().setAttribute("data-paused", String(paused));
  }, [paused, position]);

  // Accuracy circle
  useEffect(() => {
    if (!map || !position || accuracy === null || accuracy > 200) {
      if (accuracySourceRef.current && map) {
        if (map.getLayer("user-accuracy-circle")) {
          map.removeLayer("user-accuracy-circle");
        }
        if (map.getSource("user-accuracy")) {
          map.removeSource("user-accuracy");
        }
        accuracySourceRef.current = false;
      }
      return;
    }

    // Approximate accuracy circle as a polygon
    const steps = 32;
    const coords: [number, number][] = [];
    const metersPerDegreeLat = 111_320;
    const metersPerDegreeLon = metersPerDegreeLat * Math.cos((position.lat * Math.PI) / 180);

    for (let i = 0; i <= steps; i++) {
      const angle = (i / steps) * 2 * Math.PI;
      coords.push([
        position.lon + (accuracy * Math.cos(angle)) / metersPerDegreeLon,
        position.lat + (accuracy * Math.sin(angle)) / metersPerDegreeLat,
      ]);
    }

    const geojson: GeoJSON.Feature = {
      type: "Feature",
      geometry: { type: "Polygon", coordinates: [coords] },
      properties: {},
    };

    if (map.getSource("user-accuracy")) {
      (map.getSource("user-accuracy") as maplibregl.GeoJSONSource).setData(geojson);
    } else {
      map.addSource("user-accuracy", { type: "geojson", data: geojson });
      map.addLayer({
        id: "user-accuracy-circle",
        type: "fill",
        source: "user-accuracy",
        paint: {
          "fill-color": "#3b82f6",
          "fill-opacity": 0.1,
        },
      });
      accuracySourceRef.current = true;
    }

    return () => {
      if (map.getLayer("user-accuracy-circle")) {
        map.removeLayer("user-accuracy-circle");
      }
      if (map.getSource("user-accuracy")) {
        map.removeSource("user-accuracy");
      }
      accuracySourceRef.current = false;
    };
  }, [map, position, accuracy]);

  return null;
}
