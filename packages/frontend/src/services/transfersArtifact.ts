import { decode as decodeTransfers, type DecodedTransfers } from "@pt/shared/transfers";
import {clearSharedArtifactMemory, ensureSharedArtifactStored, fetchSharedArtifactBytes} from "./sharedCityArtifacts.ts";

export const clearTransferArtifactMemory = clearSharedArtifactMemory;
export const ensureTransferArtifactStored = (hash: string): Promise<void> => ensureSharedArtifactStored("transfers", hash);
export function fetchTransfersArtifactBytes(url: string, hash: string, opts: {signal?: AbortSignal} = {}): Promise<Uint8Array> {
  return fetchSharedArtifactBytes("transfers", url, hash, opts);
}

export async function fetchTransfersArtifact(url: string, hash: string, opts: {signal?: AbortSignal} = {}): Promise<DecodedTransfers> {
  return decodeTransfers(await fetchTransfersArtifactBytes(url, hash, opts));
}
