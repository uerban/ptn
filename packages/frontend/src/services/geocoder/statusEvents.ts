import type { GeocoderProviderId } from "@pt/shared";

export type GeocoderStatusEvent =
  | { kind: "provider-failed"; provider: GeocoderProviderId; error: string }
  | { kind: "provider-degraded"; provider: GeocoderProviderId; reason: string }
  | { kind: "provider-recovered"; provider: GeocoderProviderId };

export type GeocoderStatusListener = (event: GeocoderStatusEvent) => void;

export class GeocoderStatusEmitter {
  private listeners = new Set<GeocoderStatusListener>();

  subscribe(listener: GeocoderStatusListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  emit(event: GeocoderStatusEvent): void {
    for (const l of this.listeners) l(event);
  }

  clear(): void {
    this.listeners.clear();
  }
}
