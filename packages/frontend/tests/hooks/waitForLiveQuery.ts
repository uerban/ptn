import { waitFor } from "@testing-library/react";

export async function waitForLiveQuery<T>(
  read: () => T,
  pred: (v: T) => boolean,
  timeout = 2000,
): Promise<T> {
  let last!: T;
  await waitFor(() => {
    last = read();
    if (!pred(last)) throw new Error("pred not yet satisfied");
  }, { timeout });
  return last;
}
