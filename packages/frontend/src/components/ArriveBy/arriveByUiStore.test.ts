import { beforeEach, describe, expect, it } from "vitest";
import { useArriveByUi } from "./arriveByUiStore.ts";

const reset = () => useArriveByUi.setState({
  cityId: null, mode: "leave-now", draftMs: null, edited: false, draftVersion: 0, appliedMs: null, defaults: {},
});

describe("arrive-by UI state", () => {
  beforeEach(reset);

  it("fills the default on choosing Arrive by, applies only on Apply, and clears on Leave now", () => {
    const s = useArriveByUi.getState();
    s.chooseArriveBy(1000);
    expect(useArriveByUi.getState()).toMatchObject({ mode: "arrive-by", draftMs: 1000, appliedMs: null, draftVersion: 1 });
    useArriveByUi.getState().apply();
    expect(useArriveByUi.getState().appliedMs).toBe(1000);
    useArriveByUi.getState().chooseLeaveNow();
    expect(useArriveByUi.getState()).toMatchObject({ mode: "leave-now", appliedMs: null });
  });

  it("keeps an edited deadline across a mode switch", () => {
    useArriveByUi.getState().chooseArriveBy(1000);
    useArriveByUi.getState().editDraft(5000);
    useArriveByUi.getState().chooseLeaveNow();
    useArriveByUi.getState().chooseArriveBy(2000);
    expect(useArriveByUi.getState()).toMatchObject({ mode: "arrive-by", draftMs: 5000 });
  });

  it("takes a new default when the deadline was not edited", () => {
    useArriveByUi.getState().chooseArriveBy(1000);
    useArriveByUi.getState().chooseLeaveNow();
    useArriveByUi.getState().chooseArriveBy(2000);
    expect(useArriveByUi.getState().draftMs).toBe(2000);
  });

  it("does not apply an incomplete deadline", () => {
    useArriveByUi.getState().chooseArriveBy(1000);
    useArriveByUi.getState().editDraft(null);
    useArriveByUi.getState().apply();
    expect(useArriveByUi.getState().appliedMs).toBeNull();
  });

  it("keeps the first default of an endpoint pair", () => {
    useArriveByUi.getState().rememberDefault("k", 1);
    useArriveByUi.getState().rememberDefault("k", 2);
    expect(useArriveByUi.getState().defaults).toEqual({ k: 1 });
  });

  it("resets to Leave now when the city changes, not on the first sync", () => {
    useArriveByUi.getState().syncCity("vilnius");
    useArriveByUi.getState().chooseArriveBy(1000);
    useArriveByUi.getState().apply();
    useArriveByUi.getState().syncCity("vilnius");
    expect(useArriveByUi.getState().appliedMs).toBe(1000);
    useArriveByUi.getState().syncCity("riga");
    expect(useArriveByUi.getState()).toMatchObject({ cityId: "riga", mode: "leave-now", draftMs: null, appliedMs: null, defaults: {} });
  });
});
