import type { FastifyRequest } from "fastify";
import type { CityProfile, RoutingAdapter } from "@pt/shared";
import { MotisAdapter } from "./motis.js";
import { OtpAdapter } from "./otp.js";

export interface AdapterRegistry {
  get(name: string): RoutingAdapter | undefined;
  getDefault(): RoutingAdapter;
  list(): string[];
  all(): RoutingAdapter[];
}

/**
 * Resolve the adapter registry backing this request.
 *
 * Two callers, two lifetimes. The per-city backend builds ONE registry at boot
 * from its own `CITY_ID`'s bbox and decorates it on the server instance. The
 * cityless adapter shim (`adapterShim.ts`) cannot do that — it answers every
 * city from a single process — so it decorates a registry per request, chosen
 * from the city slug in the path.
 *
 * Preferring the request-scoped one keeps `search`/`nearby` as a
 * single implementation across both. Note the fallback is NOT dead code while
 * the per-city backends still exist: they never set the request decorator.
 */
export function adapterRegistryFor(request: FastifyRequest): AdapterRegistry {
  const perRequest = (request as unknown as { adapters?: AdapterRegistry }).adapters;
  if (perRequest) return perRequest;
  return (request.server as unknown as { adapters: AdapterRegistry }).adapters;
}

/**
 * @param cityBbox Envelope of the city this process serves. Passed to the MOTIS
 * adapter so stop search puts local matches first. Omit it and search keeps
 * upstream order — which is what the multi-city harness wants, since it has no
 * single city to bias toward.
 */
export function createAdapterRegistry(
  cityBbox?: CityProfile["bbox"]
): AdapterRegistry {
  const adapters = new Map<string, RoutingAdapter>();

  // Register available adapters
  const motis = new MotisAdapter(process.env.MOTIS_URL, cityBbox);
  adapters.set(motis.name, motis);

  if (process.env.OTP_BASE_URL) {
    const otp = new OtpAdapter(process.env.OTP_BASE_URL);
    adapters.set(otp.name, otp);
  }

  // Navitia adapter will be added in a later phase

  const defaultAdapter = motis;

  return {
    get(name: string) {
      return adapters.get(name);
    },
    getDefault() {
      return defaultAdapter;
    },
    list() {
      return Array.from(adapters.keys());
    },
    all() {
      return Array.from(adapters.values());
    },
  };
}
