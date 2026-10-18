import { getAddress, isAddress, parseUnits, type Hex, type RpcLog } from "viem";
import { UsageError } from "../../src/lib/cli.js";
import { explorerTx } from "../../src/lib/networks.js";
import type { Network } from "../../src/lib/mcp.js";
import { amountText, decodeLog, parseEvent, type DecodedEvent, type EventSpec } from "../../src/watch/decode.js";

// The alert conditions. A rules file is JSON:
//   { "network": "atlantic", "rules": [
//     { "id": "big-wphrs", "kind": "large-transfer", "token": "0x…", "minAmount": "0.005" },
//     { "id": "wphrs-deposit", "kind": "contract-event", "contract": "0x…", "event": "Deposit" } ] }
// large-transfer: a Transfer of the token for at least minAmount (in token units, decimals applied).
// contract-event: any occurrence of the named event on the contract (optionally only where `from`/`to` equals an address).

export type RuleSpec =
  | { id: string; kind: "large-transfer"; token: string; minAmount: string }
  | { id: string; kind: "contract-event"; contract: string; event: string; involving?: string };

export interface RulesFile {
  network: Network;
  rules: RuleSpec[];
}

export interface Rule {
  id: string;
  kind: RuleSpec["kind"];
  address: Hex;
  spec: EventSpec;
  /** large-transfer: the threshold in base units. */
  minRaw?: bigint;
  minText?: string;
  involving?: Hex;
  title: string;
}

export interface Alert {
  rule: Rule;
  event: DecodedEvent;
  /** `ruleId:txHash:logIndex`: one alert per rule per event, ever. */
  key: string;
}

const bad = (m: string) => new UsageError(`rules file: ${m}`);

/** Read and check a parsed rules file. Decimals are needed to turn minAmount into base units, so the caller supplies them. */
export function compileRules(file: unknown, decimalsOf: (token: Hex) => number | undefined): { network: Network; rules: Rule[] } {
  const f = file as Partial<RulesFile> | null;
  if (!f || typeof f !== "object" || !Array.isArray(f.rules) || f.rules.length === 0) throw bad('needs a "rules" array with at least one rule');
  if (f.network !== "atlantic" && f.network !== "pharos") throw bad('"network" must be "atlantic" or "pharos"');
  const ids = new Set<string>();
  const rules = f.rules.map((r, i): Rule => {
    const at = `rules[${i}]`;
    if (!r || typeof r !== "object") throw bad(`${at} must be an object`);
    if (typeof r.id !== "string" || !/^[\w-]+$/.test(r.id)) throw bad(`${at}.id must be a short name (letters, digits, - and _)`);
    if (ids.has(r.id)) throw bad(`duplicate rule id ${r.id}`);
    ids.add(r.id);
    if (r.kind === "large-transfer") {
      if (typeof r.token !== "string" || !isAddress(r.token)) throw bad(`${at}.token must be an address`);
      const token = getAddress(r.token);
      const decimals = decimalsOf(token);
      if (decimals === undefined) throw bad(`${at}.token ${token} has no decimals(): large-transfer needs an ERC-20`);
      if (typeof r.minAmount !== "string" || !/^\d+(\.\d+)?$/.test(r.minAmount)) throw bad(`${at}.minAmount must be a decimal number in token units, as a string (e.g. "0.005")`);
      const minRaw = parseUnits(r.minAmount, decimals);
      if (minRaw === 0n) throw bad(`${at}.minAmount must be above zero`);
      return { id: r.id, kind: r.kind, address: token, spec: parseEvent("Transfer"), minRaw, minText: r.minAmount, title: "Large transfer" };
    }
    if (r.kind === "contract-event") {
      if (typeof r.contract !== "string" || !isAddress(r.contract)) throw bad(`${at}.contract must be an address`);
      if (typeof r.event !== "string") throw bad(`${at}.event must be an event name or full signature`);
      if (r.involving !== undefined && (typeof r.involving !== "string" || !isAddress(r.involving))) throw bad(`${at}.involving must be an address`);
      const spec = parseEvent(r.event);
      return { id: r.id, kind: r.kind, address: getAddress(r.contract), spec, ...(r.involving ? { involving: getAddress(r.involving) } : {}), title: `${spec.item.name} event` };
    }
    throw bad(`${at}.kind must be "large-transfer" or "contract-event"`);
  });
  return { network: f.network, rules };
}

/** The alerts one raw log triggers (zero, one or several rules). */
export function match(rules: Rule[], log: RpcLog): Alert[] {
  const out: Alert[] = [];
  for (const rule of rules) {
    if (log.address.toLowerCase() !== rule.address.toLowerCase() || log.topics[0]?.toLowerCase() !== rule.spec.topic0.toLowerCase()) continue;
    const event = decodeLog(rule.spec, log);
    if (rule.minRaw !== undefined && (event.amountRaw === undefined || event.amountRaw < rule.minRaw)) continue;
    if (rule.involving && event.from?.toLowerCase() !== rule.involving.toLowerCase() && event.to?.toLowerCase() !== rule.involving.toLowerCase()) continue;
    out.push({ rule, event, key: `${rule.id}:${event.tx.toLowerCase()}:${event.logIndex}` });
  }
  return out;
}

/** What happened, the value, and the explorer link: the three things every alert states. */
export function alertText(a: Alert, network: Network, decimals?: number, symbol?: string): string {
  const e = a.event;
  const value = amountText(e, decimals, symbol);
  const why = a.rule.minText ? ` (rule \`${a.rule.id}\`: at least ${a.rule.minText}${symbol ? ` ${symbol}` : ""})` : ` (rule \`${a.rule.id}\`)`;
  return [
    `🔔 **${a.rule.title}** on Pharos ${network === "atlantic" ? "Atlantic testnet" : "mainnet"}${why}`,
    `**What:** ${e.event} on ${e.contract}${e.from && e.to ? `, ${e.from} → ${e.to}` : e.from ? `, by ${e.from}` : e.to ? `, to ${e.to}` : ""}`,
    `**Value:** ${value}`,
    `**Block:** ${e.block} · **Tx:** ${explorerTx(network, e.tx)}`,
  ].join("\n");
}
