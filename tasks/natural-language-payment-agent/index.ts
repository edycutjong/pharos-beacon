// Natural-Language Payment Agent (Medium · 100 pts): "send 0.01 PHRS to 0x…" → parsed, validated, summarised, and prepared as an
// UNSIGNED Atlantic transaction. It signs only with --execute. English and Bahasa Indonesia; asks when anything is ambiguous.
//   npm run natural-language-payment-agent -- "send 0.01 PHRS to 0x…" [--followup "USDC"]… [--from 0x…] [--parser auto|llm|rules]
//                                              [--execute] [--proof name]
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { choice, isMain, parseCli, runCli, type RunContext } from "../../src/lib/cli.js";
import { chainMcp } from "../../src/lib/mcp.js";
import { proofMeta, writeProof } from "../../src/lib/proof.js";
import { testnetSigner } from "../../src/lib/signer.js";
import { geminiJson } from "../../src/pay/llm.js";
import { parseRules, parseWithLlm, type Parsed } from "../../src/pay/parse.js";
import { preparePayment, txJson } from "../../src/pay/prepare.js";
import { maybeExecute, senderAddress, show } from "../../src/pay/run.js";

const TASK = "natural-language-payment-agent";
const HERE = fileURLToPath(new URL(".", import.meta.url));

export async function main(ctx: RunContext, argv = process.argv.slice(2)): Promise<number> {
  const { values, positionals } = parseCli(
    {
      usage: `npm run ${TASK} -- "<instruction>" [--followup "<answer>"]… [--from 0x…] [--parser auto|llm|rules] [--execute] [--proof name]`,
      options: { followup: { type: "string", multiple: true }, from: { type: "string" }, parser: { type: "string", default: "auto" }, execute: { type: "boolean", default: false }, proof: { type: "string" } },
      positionals: [1, 1],
    },
    argv,
  );
  const mode = choice("--parser", values.parser, ["auto", "llm", "rules"] as const);
  const turns = [positionals[0], ...(values.followup ?? [])];
  const say = (l: string) => console.log(l);
  turns.forEach((t, i) => say(`${i === 0 ? "you" : "you (follow-up)"}: ${t}`));

  let parsed: Parsed;
  const llm = mode === "rules" ? undefined : geminiJson();
  if (mode === "llm" && !llm) throw new Error("--parser llm needs a key in ~/.config/gemini/credentials.json");
  if (llm) {
    try {
      parsed = await parseWithLlm(turns, llm);
    } catch (e) {
      if (mode === "llm") throw e;
      say(`(LLM unavailable: ${(e as Error).message}; using the rule parser)`);
      parsed = parseRules(turns);
    }
  } else parsed = parseRules(turns);
  say(`parser: ${parsed.parser} · language: ${parsed.lang}`);
  say(`understood: ${JSON.stringify(parsed.draft)}`);

  if (parsed.questions.length) {
    say("\nI need one more thing before I prepare anything:");
    parsed.questions.forEach((q) => say(`  ? ${q}`));
    say(`\nAnswer with: --followup "<your answer>"`);
    if (values.proof) {
      const mcp0 = { endpoint: "none", network: "atlantic" as const, chainId: 688689 };
      console.log(`proof: ${writeProof(join(HERE, "proof", `${values.proof}.json`), { turns, parsed, outcome: "asked-follow-up" }, proofMeta(TASK, mcp0))}`);
    }
    return 2;
  }

  const from = senderAddress(values.from);
  const mcp = await chainMcp("atlantic", { broadcast: values.execute });
  ctx.onExit(() => mcp.close());
  const meta = values.proof ? proofMeta(TASK, mcp) : undefined;
  const prep = await preparePayment(parsed.draft, { call: mcp.call, from });
  say("");
  show(prep, say);
  const sent = await maybeExecute(prep, { execute: values.execute, signer: () => testnetSigner(mcp), say });
  if (values.proof) {
    const body = { turns, parsed, outcome: !prep.ok ? "refused" : sent ? "sent" : "prepared-unsigned", checks: prep.checks, ...(prep.tx ? { unsignedTx: txJson(prep.tx), walletRequest: prep.walletRequest } : {}), ...(sent ? { sent: { hash: sent.hash, status: sent.status, block: sent.blockNumber.toString(), url: sent.url } } : {}) };
    say(`proof: ${writeProof(join(HERE, "proof", `${values.proof}.json`), body, meta!)}`);
  }
  return prep.ok ? 0 : 1;
}

if (isMain(import.meta.url)) await runCli(main);
