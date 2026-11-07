/**
 * Remote routing and remote stop search, expressed as network flows.
 *
 * The routing provider picks the flow: the operator's planner is
 * `operator.remote-routing`, any other provider is
 * `external.remote-routing` for that provider. Remote stop search reaches a
 * third party through the operator proxy and is `external.stop-search`.
 *
 * Choosing a remote option in Settings is a deliberate action, so it grants
 * the one flow it will use. Choosing a local option only changes the
 * preference: it never rewrites a decision.
 */
import { canUse, useCanUse } from "../privacy/canUse.ts";
import { grantFlow, isFlowAvailable, type GrantSource } from "../privacy/flowGrants.ts";
import {
  useSettingsStore,
  type RemoteRoutingProvider,
  type RoutingMode,
  type SearchProvider,
} from "../stores/settingsStore.ts";

export const OPERATOR_ROUTING_FLOW = "operator.remote-routing";
export const EXTERNAL_ROUTING_FLOW = "external.remote-routing";
export const REMOTE_STOP_SEARCH_FLOW = "external.stop-search";

function routingFlow(
  provider: RemoteRoutingProvider,
): readonly [flowId: string, providerId?: string] {
  return provider === "operator"
    ? [OPERATOR_ROUTING_FLOW]
    : [EXTERNAL_ROUTING_FLOW, provider];
}

/** Request-boundary check for remote routing through `provider`. */
export function canUseRemoteRouting(provider: RemoteRoutingProvider): boolean {
  return canUse(...routingFlow(provider));
}

/** React binding of `canUseRemoteRouting`; re-renders on decision changes. */
export function useCanUseRemoteRouting(provider: RemoteRoutingProvider): boolean {
  return useCanUse(...routingFlow(provider));
}

/** Whether remote routing through `provider` can be offered at all. */
export function isRemoteRoutingAvailable(provider: RemoteRoutingProvider): boolean {
  return isFlowAvailable(...routingFlow(provider));
}

/** Grant remote routing through `provider` after a deliberate action. */
export function grantRemoteRouting(
  provider: RemoteRoutingProvider,
  source: GrantSource,
): boolean {
  const [flowId, providerId] = routingFlow(provider);
  return grantFlow(flowId, source, providerId);
}

/** Request-boundary check for remote stop search. */
export function canUseRemoteStopSearch(): boolean {
  return canUse(REMOTE_STOP_SEARCH_FLOW);
}

/** Settings: choose the routing strategy. A remote strategy grants the flow
 * of the selected provider. */
export function chooseRoutingMode(mode: RoutingMode): void {
  const settings = useSettingsStore.getState();
  if (mode !== "on-device") grantRemoteRouting(settings.routingProvider, "settings");
  settings.setRoutingMode(mode);
}

/** Settings: choose the remote routing provider. It is granted only while a
 * remote strategy will actually use it. */
export function chooseRoutingProvider(provider: RemoteRoutingProvider): void {
  const settings = useSettingsStore.getState();
  if (settings.routingMode !== "on-device") grantRemoteRouting(provider, "settings");
  settings.setRoutingProvider(provider);
}

/** Settings: choose where stop search runs. Searching online grants remote
 * stop search. */
export function chooseSearchProvider(provider: SearchProvider): void {
  if (provider === "remote") grantFlow(REMOTE_STOP_SEARCH_FLOW, "settings");
  useSettingsStore.getState().setSearchProvider(provider);
}
