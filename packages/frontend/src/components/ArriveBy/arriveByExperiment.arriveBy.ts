/** The opt-in build's side of `arriveByExperiment.ts`. */
import type { ComponentType } from "react";
import type { ArriveByResultsProps, ArriveByToolbarProps } from "./arriveByTypes.ts";
import { ArriveByToolbar as Toolbar } from "./ArriveByToolbar.tsx";
import { ArriveByResults as Results } from "./ArriveByResults.tsx";

export const ArriveByToolbar: ComponentType<ArriveByToolbarProps> | null = Toolbar;
export const ArriveByResults: ComponentType<ArriveByResultsProps> | null = Results;
