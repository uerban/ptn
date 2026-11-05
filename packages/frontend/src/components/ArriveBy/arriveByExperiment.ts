/**
 * Build-time gate of the opt-in Arrive-by UI. The default build gets `null`
 * here, so Search draws nothing extra and Rollup drops both call sites.
 * `PTN_ARRIVE_BY_EXPERIMENT=1` aliases this module to
 * `arriveByExperiment.arriveBy.ts` (see `vite.config.ts`), as it does the
 * router worker entry.
 */
import type { ComponentType } from "react";
import type { ArriveByResultsProps, ArriveByToolbarProps } from "./arriveByTypes.ts";

export const ArriveByToolbar: ComponentType<ArriveByToolbarProps> | null = null;
export const ArriveByResults: ComponentType<ArriveByResultsProps> | null = null;
