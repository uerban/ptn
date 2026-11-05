import { useEffect } from "react";
import type * as maplibregl from "maplibre-gl";
import type { Leg } from "@pt/shared";
import { useWalkLegGeometry } from "../../../hooks/useWalkLegGeometry.ts";
import { enqueueSetData } from "./rafScheduler.ts";

interface Props {
  map: maplibregl.Map;
  leg: Leg; // mode === "WALK"
  index: number;
  statusOpacity: number;
}

export function WalkLegLayer({ map, leg, index, statusOpacity }: Props) {
  const geom = useWalkLegGeometry(leg.from.location, leg.to.location);
  useEffect(() => {
    enqueueSetData(map, index, "walk", leg, geom, statusOpacity);
  }, [map, index, leg, geom.coords, geom.source, geom.pending, statusOpacity]);
  return null;
}
