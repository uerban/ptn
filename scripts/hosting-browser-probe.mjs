// Runs in the page before application scripts create their workers.
export const installBrowserProbe = ({at, fromStopId, toStopId}) => {
  globalThis.__PTN_HOST_CHECK__ = {transitResults: 0, catalogStops: 0, journeyStopsPresent: false};
  const NativeWorker = Worker;
  globalThis.Worker = class extends NativeWorker {
    constructor(url, options) {
      super(url, options);
      if (/ptbCatalog\.worker/.test(String(url))) {
        this.addEventListener("message", ({data}) => {
          if (data?.ok && data.data?.meta?.cityId === "vilnius" && Array.isArray(data.data.stops)) {
            const stops = data.data.stops;
            globalThis.__PTN_HOST_CHECK__.catalogStops = stops.length;
            globalThis.__PTN_HOST_CHECK__.journeyStopsPresent =
              stops.some(stop => stop.id === fromStopId) && stops.some(stop => stop.id === toStopId);
          }
        });
      }
      if (/ptRouter\.worker/.test(String(url))) {
        this.addEventListener("message", ({data}) => {
          if (data?.ok && Array.isArray(data.value)) {
            globalThis.__PTN_HOST_CHECK__.transitResults += data.value.filter(itinerary =>
              itinerary.legs?.some(leg => typeof leg.tripId === "string" && leg.tripId.length > 0)).length;
          }
        });
      }
    }
  };
  const NativeDate = Date;
  function FixedDate(...args) {
    if (!new.target) return new NativeDate(at).toString();
    return Reflect.construct(NativeDate, args.length ? args : [at], new.target);
  }
  Object.setPrototypeOf(FixedDate, NativeDate);
  FixedDate.prototype = NativeDate.prototype;
  FixedDate.now = () => at;
  globalThis.Date = FixedDate;
};
