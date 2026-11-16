import { createContext, useContext } from "react";

/**
 * The leave time the rider asked for when it is not now (epoch ms), for the
 * result cards below. See `ItineraryDisplayContext.earliestLeaveMs`.
 */
export const LeaveFloorContext = createContext<number | undefined>(undefined);

export function useLeaveFloorMs(): number | undefined {
  return useContext(LeaveFloorContext);
}
