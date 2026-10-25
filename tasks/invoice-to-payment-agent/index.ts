// Invoice-to-Payment Agent (Medium · 100 pts): reads an invoice (JSON, plain text or PDF), flags what is missing or does not
// add up, and prepares the matching UNSIGNED Atlantic payment with the invoice reference inside the transaction data. A
// duplicate-invoice guard refuses to pay the same invoice twice. Signs only with --execute.
//   npm run invoice-to-payment-agent -- tasks/invoice-to-payment-agent/samples/acme-0042.json [--pay-in USDC] [--from 0x…]
//                                          [--parser auto|rules] [--state file] [--execute] [--proof name]
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { envOr } from "../../src/lib/env.js";
import { choice, isMain, parseCli, runCli, UsageError, type RunContext } from "../../src/lib/cli.js";
import { chainMcp } from "../../src/lib/mcp.js";
import { proofMeta, writeProof } from "../../src/lib/proof.js";
import { testnetSigner } from "../../src/lib/signer.js";
import { withLock } from "../../src/lib/state.js";
import { detectFormat, extractInvoice, findPaid, fingerprint, pdfToText, recordPaid, toDraft } from "../../src/pay/invoice.js";
import { geminiJson } from "../../src/pay/llm.js";
import { preparePayment, txJson } from "../../src/pay/prepare.js";
import { maybeExecute, senderAddress, show } from "../../src/pay/run.js";

const TASK = "invoice-to-payment-agent";
const HERE = fileURLToPath(new URL(".", import.meta.url));

export async function main(ctx: RunContext, argv = process.argv.slice(2)): Promise<number> {
  const { values, positionals } = parseCli(
    {
      usage: `npm run ${TASK} -- <invoice.json|.txt|.pdf> [--pay-in USDC] [--from 0x…] [--parser auto|rules] [--state file] [--execute] [--proof name]`,
      options: {
        "pay-in": { type: "string" }, from: { type: "string" }, parser: { type: "string", default: "auto" }, state: { type: "string" },
        execute: { type: "boolean", default: false }, proof: { type: "string" },
      },
      positionals: [1, 1],
    },
    argv,
  );
  const mode = choice("--parser", values.parser, ["auto", "rules"] as const);
  const file = positionals[0];
  const say = (l: string) => console.log(l);
  let raw: string;
  try {
    raw = /\.pdf$/i.test(file) ? pdfToText(file) : readFileSync(file, "utf8");
  } catch (e) {
    throw new UsageError(`${file}: ${(e as Error).message}`);
  }
  const format = detectFormat(file, raw);
  const x = await extractInvoice(raw, format, mode === "auto" ? geminiJson() : undefined);
  say(`invoice: ${file} (${format}) · read by ${x.via}`);
  say(`  number    ${x.number ?? "—"}\n  issuer    ${x.issuer ?? "—"}\n  payee     ${x.payee ?? "—"}\n  amount    ${x.amount ?? "—"} ${x.currency ?? ""}`);

  const { draft, flags, notes } = toDraft(x, values["pay-in"]);
  notes.forEach((n) => say(`note: ${n}`));
  const proof = async (body: Record<string, unknown>, mcp = { endpoint: "none", network: "atlantic" as const, chainId: 688689 }) => {
    if (values.proof) say(`proof: ${writeProof(join(HERE, "proof", `${values.proof}.json`), { invoice: file, extracted: x, ...body }, proofMeta(TASK, mcp))}`);
  };
  if (!draft) {
    say("\nFLAGGED: nothing was prepared. The invoice needs a human:");
    flags.forEach((f) => say(`  ! ${f}`));
    await proof({ outcome: "flagged", flags });
    return 1;
  }

  const stateFile = values.state ?? envOr("INVOICE_STATE", join(HERE, "state", "paid.json"));
  const fp = fingerprint({ number: x.number, issuer: x.issuer, amount: x.amount, currency: x.currency });
  const dup = findPaid(stateFile, fp);
  say(`fingerprint ${fp} (invoice number + issuer + amount + currency)`);
  if (dup) {
    say(`\nDUPLICATE: invoice ${dup.number} was already paid (${dup.amount} ${dup.token}) in ${dup.hash}\n${dup.url}\nrefused: it would be paid twice.`);
    await proof({ outcome: "duplicate-refused", fingerprint: fp, firstPayment: dup });
    return 1;
  }

  const from = senderAddress(values.from);
  const mcp = await chainMcp("atlantic", { broadcast: values.execute });
  ctx.onExit(() => mcp.close());
  const meta = values.proof ? proofMeta(TASK, mcp) : undefined;
  const prep = await preparePayment(draft, { call: mcp.call, from });
  say("");
  show(prep, say);
  const sent = prep.ok && values.execute ? await withLock(stateFile, async () => {
    if (findPaid(stateFile, fp)) throw new Error("this invoice was paid by another run a moment ago: refusing");
    const s = await maybeExecute(prep, { execute: true, signer: () => testnetSigner(mcp), say });
    if (s && s.status === "success") recordPaid(stateFile, { fingerprint: fp, number: x.number!, issuer: x.issuer, amount: draft.amount!, token: draft.token!, hash: s.hash, url: s.url, at: new Date().toISOString() });
    return s;
  }) : await maybeExecute(prep, { execute: false, signer: () => testnetSigner(mcp), say });
  if (values.proof) {
    const body = { outcome: !prep.ok ? "refused" : sent ? "sent" : "prepared-unsigned", fingerprint: fp, notes, checks: prep.checks, ...(prep.tx ? { unsignedTx: txJson(prep.tx), walletRequest: prep.walletRequest } : {}), ...(sent ? { sent: { hash: sent.hash, status: sent.status, block: sent.blockNumber.toString(), url: sent.url } } : {}) };
    say(`proof: ${writeProof(join(HERE, "proof", `${values.proof}.json`), { invoice: file, extracted: x, ...body }, meta!)}`);
  }
  return prep.ok ? 0 : 1;
}

if (isMain(import.meta.url)) await runCli(main);
