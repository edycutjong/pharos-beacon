// Shared by the Natural-Language Payment and Invoice-to-Payment demo endpoints: the Atlantic reads, the "from" address and the
// View of a prepared payment. These endpoints only PREPARE: the page has no key, signs nothing and sends nothing; the CLI's
// --execute step is not reachable from here.
import { isAddress, type Hex } from "viem";
import { checksTable, txJson, type Prepared } from "../pay/prepare.js";
import { InputError } from "./live.js";
import type { View } from "./view.js";

/** The funded public address used when no sender is given: only its balance is read, its key is not on the page. */
export const DEFAULT_FROM = "0x317bca01Bb101C0F1E86C21576a4e14D92B02975" as Hex;

export function parseFrom(raw: string | null | undefined): Hex {
  const v = (raw ?? "").trim();
  if (!v) return DEFAULT_FROM;
  if (!isAddress(v, { strict: false })) throw new InputError("from must be a 0x address (40 hex characters)");
  return v as Hex;
}

export function preparedView(prep: Prepared, head: { verdict: string; note?: string }, extra: View["evidence"] = []): View {
  const tx = prep.tx ? txJson(prep.tx) : undefined;
  return {
    tone: prep.ok ? "ok" : "bad",
    verdict: prep.ok ? head.verdict : "REFUSED: nothing was prepared",
    note: prep.ok ? `${prep.summary ?? ""} NOT SIGNED. Nothing was sent: this page has no key and no send tool; the CLI signs only with --execute.` : head.note,
    tables: [{ head: ["Check", "Result", "Detail"], rows: prep.checks.map((c) => [c.name, c.ok ? "ok" : "FAILED", c.detail]) }],
    ...(tx ? { text: `unsigned transaction\n${JSON.stringify(tx, null, 2)}\n\nwallet signing request\n${JSON.stringify(prep.walletRequest, null, 2)}` } : { text: checksTable(prep.checks) }),
    evidence: [["Outcome", prep.ok ? "prepared-unsigned" : "refused"], ...extra],
    summary: prep.ok ? "Prepared, not signed: the unsigned transaction and the wallet request are shown." : "Refused before any transaction was prepared.",
  };
}
