/** Local Performance Timeline diagnostics; no coordinates, saves, or telemetry.
 * Keep only the latest entry per stage so normal app use stays bounded. */
export async function measureCityStage<T>(
  cityId: string | null,
  stage: string,
  work: () => PromiseLike<T>,
): Promise<T> {
  const start = performance.now();
  let outcome = "complete";
  try {
    return await work();
  } catch (error) {
    outcome = error instanceof Error && error.name === "AbortError" ? "aborted" : "failed";
    throw error;
  } finally {
    const name = `ptn:city:${stage}`;
    performance.clearMeasures(name);
    performance.measure(name, {start, end: performance.now(), detail: {cityId, outcome}});
  }
}
