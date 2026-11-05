import { useCityStore } from "../../stores/cityStore.ts";

export function TransitAttribution() {
  const sources = useCityStore((s) => s.activeCity.transitSources);
  if (!sources?.length) return null;
  return (
    <p className="mt-3 text-xs text-fg-muted">
      {sources.map((source, i) => (
        <span key={source.url}>
          {i > 0 && " · "}
          <a href={source.url} target="_blank" rel="noopener noreferrer" className="underline">
            {source.name}
          </a>
        </span>
      ))}
    </p>
  );
}
