import { useEffect } from "react";
import type * as maplibregl from "maplibre-gl";
import type { Leg, RaptorTransitLeg } from "@pt/shared";
import { useTransitLegGeometry } from "../../../hooks/useTransitLegGeometry.ts";
import { enqueueSetData } from "./rafScheduler.ts";

interface Props {
  map: maplibregl.Map;
  leg: Leg; // mode !== "WALK"
  index: number;
  statusOpacity: number;
}

export function TransitLegLayer({ map, leg, index, statusOpacity }: Props) {
  // Guidance `Leg` has all transit-only fields as optional; `RaptorTransitLeg`
  // requires `routeId`, `tripId`, `boardStopIdx`, `alightStopIdx`. If any are
  // missing we can't build shape geometry — skip rendering this leg.
  if (
    leg.routeId === undefined ||
    leg.tripId === undefined ||
    leg.boardStopIdx === undefined ||
    leg.alightStopIdx === undefined
  ) {
    return null;
  }
  const asRaptor: RaptorTransitLeg = {
    type: "transit",
    fromStopId: leg.from.stopId ?? "",
    toStopId: leg.to.stopId ?? "",
    departSecs: 0,
    arriveSecs: leg.durationSeconds,
    routeId: leg.routeId,
    tripId: leg.tripId,
    boardStopIdx: leg.boardStopIdx,
    alightStopIdx: leg.alightStopIdx,
    mode: leg.mode,
    routeShortName: leg.routeShortName,
    routeColor: leg.routeColor,
    headsign: leg.headsign,
    intermediateStops: leg.intermediateStops,
    patternStopIds: leg.patternStopIds,
  };
  // Hooks after the early return is a rules-of-hooks violation, so we
  // re-enter — but `leg` identity drives the effect deps and the guard is
  // above. We need hooks to run unconditionally; restructure below.
  return (
    <TransitLegLayerInner
      map={map}
      leg={asRaptor}
      guidanceLeg={leg}
      index={index}
      statusOpacity={statusOpacity}
    />
  );
}

interface InnerProps {
  map: maplibregl.Map;
  leg: RaptorTransitLeg;
  guidanceLeg: Leg;
  index: number;
  statusOpacity: number;
}

function TransitLegLayerInner({
  map,
  leg,
  guidanceLeg,
  index,
  statusOpacity,
}: InnerProps) {
  const geom = useTransitLegGeometry(leg, guidanceLeg.from.location, guidanceLeg.to.location);
  useEffect(() => {
    enqueueSetData(map, index, "transit", guidanceLeg, geom, statusOpacity);
  }, [map, index, guidanceLeg, geom.coords, geom.source, geom.partial, geom.pending, statusOpacity]);
  return null;
}
