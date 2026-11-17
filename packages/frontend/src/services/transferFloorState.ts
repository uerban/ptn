import type {RaptorIndex, TransferRule} from "./raptorIndex.ts";
import {wire,freeze} from "./searchEvidenceWire.ts";
type Tables = Pick<RaptorIndex,"transferRules"|"transferRulesRouteScoped"|"transferRulesTripScoped">;
type Rows = [string, TransferRule][] | null;
export interface TransferFloorState {
  format: "ptn-transfer-floor-state";
  version: 1;
  stop: Rows;
  route: Rows;
  trip: Rows;
}
/** Raw applied map entries in insertion order; no synthesis from observed answers. */
export function captureTransferFloorState(index: Tables): TransferFloorState {
  return freeze(wire({format:"ptn-transfer-floor-state",version:1,stop:index.transferRules?[...index.transferRules]:null,
    route:index.transferRulesRouteScoped?[...index.transferRulesRouteScoped]:null,trip:index.transferRulesTripScoped?[...index.transferRulesTripScoped]:null}));
}
export function restoreTransferFloorState(source: TransferFloorState): Tables {
  const state=wire(source);
  if(state.format!=="ptn-transfer-floor-state"||state.version!==1)throw new Error("Unsupported transfer floor state");
  const table=(rows: Rows) => {
    if(rows===null)return undefined;
    if(!Array.isArray(rows))throw new Error("Invalid transfer rule table");
    const map=new Map<string,TransferRule>();
    for(const row of rows) {
      if(!Array.isArray(row)||row.length!==2||typeof row[0]!=="string"||!row[1]||typeof row[1]!=="object"
        ||!Number.isFinite(row[1].type)||(row[1].minSecs!==undefined&&!Number.isFinite(row[1].minSecs))||map.has(row[0]))throw new Error("Invalid or duplicate transfer rule entry");
      map.set(row[0],row[1]);
    }
    return map;
  };
  return {transferRules:table(state.stop),transferRulesRouteScoped:table(state.route),transferRulesTripScoped:table(state.trip)};
}
