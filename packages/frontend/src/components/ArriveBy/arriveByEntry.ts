/**
 * Build-time gate of the Arrive-by UI. A build without the arrive-by package
 * (`PTN_ARRIVE_BY_EXPERIMENT=0`, or none built) gets `null` here, so Search
 * draws nothing extra and Rollup drops both call sites. Otherwise
 * `vite.config.ts` aliases this module to `arriveByEntry.arriveBy.ts`, as it
 * does the router worker entry.
 */
import type { ComponentType } from "react";
import type { ArriveByResultsProps, ArriveByToolbarProps } from "./arriveByTypes.ts";

export const ArriveByToolbar: ComponentType<ArriveByToolbarProps> | null = null;
export const ArriveByResults: ComponentType<ArriveByResultsProps> | null = null;
