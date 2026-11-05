/** Native fixture seam used by graph host/client tests. Distribution verification
 * is covered separately by walkGraphResource and walkGraphOffline tests. */
import type {WalkGraphArtifacts} from "./walkGraphOffline.ts";
export function fixtureGraphArtifacts(fetcher: typeof fetch): WalkGraphArtifacts {
  return {
    async load(cityId, signal) {
      const response = await fetcher(`/walk-graph/${cityId}.ptwg.br`, {signal});
      if (response.status === 404 || response.headers.get("content-type")?.includes("text/html")) return null;
      if (!response.ok) throw new Error(`walk graph HTTP ${response.status}`);
      return {compressed: await response.arrayBuffer()};
    },
    fallback: async () => null,
    remember: async () => {},
  };
}
