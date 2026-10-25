import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { handle as arb, parseRun as arbParse } from "../tasks/arbitrage-scanner/web.js";
import { handle as liq, parseRun as liqParse } from "../tasks/liquidation-watchdog/web.js";
import { handle as agg, parseRun as aggParse } from "../tasks/multi-protocol-aggregator/web.js";
import { handle as port, parseRun as portParse } from "../tasks/portfolio-assistant/web.js";
import { handle as saga, parseRun as sagaParse } from "../tasks/saga-executor/web.js";
import { handle as yld, parseRun as yldParse } from "../tasks/yield-optimizer/web.js";
import { events, req } from "./web-helpers.js";

const SLUGS = ["liquidation-watchdog", "portfolio-assistant", "yield-optimizer", "multi-protocol-aggregator", "arbitrage-scanner", "saga-executor"] as const;
const W = "0x62A0e4b7fD967fab5be1a733c09b22eBC4510673";
const u = (q: string) => new URL(`http://x/?${q}`);

describe("wave 4 web: parameters", () => {
  it("liquidation: thresholds and shock are bounded and ordered", () => {
    expect(liqParse(u("shock=0.1&warn=1.2&critical=1.05"))).toEqual({ shock: 0.1, warn: 1.2, critical: 1.05 });
    expect(() => liqParse(u("shock=0.9"))).toThrow(/shock/);
    expect(() => liqParse(u("warn=1.1&critical=1.2"))).toThrow(/critical must be below warn/);
  });
  it("portfolio: wallet, question and block are checked", () => {
    expect(portParse(u(`wallet=${W}&q=hi&block=21146194`)).block).toBe(21146194n);
    expect(() => portParse(u("wallet=0x12&q=hi"))).toThrow(/wallet/);
    expect(() => portParse(u(`wallet=${W}`))).toThrow(/question/);
    expect(() => portParse(u(`wallet=${W}&q=${"a".repeat(201)}`))).toThrow(/200/);
    expect(() => portParse(u(`wallet=${W}&q=x&block=abc`))).toThrow(/block/);
  });
  it("yield: wallet required, numbers bounded", () => {
    expect(yldParse(u(`wallet=${W}&haircut=0`)).haircut).toBe(0);
    expect(() => yldParse(u("haircut=0.5"))).toThrow(/wallet/);
    expect(() => yldParse(u(`wallet=${W}&haircut=2`))).toThrow(/haircut/);
    expect(() => yldParse(u(`wallet=${W}&holdDays=0`))).toThrow(/holdDays/);
  });
  it("aggregator: a deposit needs an amount, 'all' is for withdrawals, down names a protocol or venue", () => {
    expect(aggParse(u("kind=rates")).kind).toBe("rates");
    expect(() => aggParse(u("kind=deposit"))).toThrow(/amount/);
    expect(() => aggParse(u("kind=deposit&amount=all"))).toThrow(/amount/);
    expect(aggParse(u("kind=withdraw&amount=all")).amount).toBe("all");
    expect(() => aggParse(u("kind=rates&amount=5"))).toThrow(/deposit and withdraw/);
    expect(aggParse(u("kind=deposit&amount=250&down=morpho,morpho-c79579")).down).toEqual(["morpho", "morpho-c79579"]);
    expect(() => aggParse(u("kind=deposit&amount=250&down=uniswap"))).toThrow(/down/);
    expect(() => aggParse(u("kind=bridge"))).toThrow(/kind/);
  });
  it("arbitrage: sizes and threshold are amounts, costs bounded", () => {
    expect(arbParse(u("")).sizes).toBe("0.01,0.05,0.1,0.25,0.5");
    expect(() => arbParse(u("sizes=0.1,x"))).toThrow(/sizes/);
    expect(() => arbParse(u("sizes=1,2,3,4,5,6,7"))).toThrow(/at most 6/);
    expect(() => arbParse(u("minProfit=-1"))).toThrow(/minProfit/);
    expect(() => arbParse(u("slippageBps=900"))).toThrow(/slippageBps/);
  });
  it("saga: only a small WPHRS amount, only the three recorded runs", () => {
    expect(sagaParse(u("mode=plan&amount=0.001"))).toEqual({ mode: "plan", amount: "0.001" });
    expect(() => sagaParse(u("mode=plan&amount=5"))).toThrow(/amount/);
    expect(() => sagaParse(u("mode=run"))).toThrow(/mode/);
    expect(() => sagaParse(u("mode=recorded&which=other"))).toThrow(/which/);
  });
});

describe("wave 4 web: endpoints", () => {
  it("every endpoint answers info and turns a bad query into a 400", async () => {
    for (const [h, bad] of [[liq, "shock=9"], [port, "wallet=x"], [yld, "wallet=x"], [agg, "kind=zzz"], [arb, "slippageBps=-1"], [saga, "mode=zzz"]] as const) {
      const info = await h(req("action=info"));
      expect(info.status).toBe(200);
      expect(((await info.json()) as { task: string }).task).toBeTruthy();
      expect((await h(req(`action=run&${bad}`))).status).toBe(400);
    }
  });
  it("saga: the three recorded runs replay with explorer links and say RECORDED", async () => {
    for (const which of ["success", "forced-failure", "crash-resume"]) {
      const ev = await events(await saga(req(`action=run&mode=recorded&which=${which}`)));
      const done = ev.at(-1)!;
      expect(done.type).toBe("done");
      expect(done.view.verdict).toMatch(/^RECORDED run/);
      const links = done.view.tables[0].rows.flat().filter((c: unknown) => typeof c === "object");
      expect(links.length).toBeGreaterThan(3);
      expect(links.every((c: { href: string }) => c.href.startsWith("https://atlantic.pharosscan.xyz/tx/0x"))).toBe(true);
    }
    const fail = (await events(await saga(req("action=run&mode=recorded&which=forced-failure")))).at(-1)!;
    expect(fail.view.tone).toBe("warn");
    expect(JSON.stringify(fail.view.tables[0].rows)).toContain("VaultClosed");
  });
});

describe("wave 4 web: structure", () => {
  const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
  it("the router, the hub and a page exist for every task", () => {
    const router = read("api/router.ts");
    const hub = read("web/index.html");
    for (const s of SLUGS) {
      expect(router).toContain(`"${s}": () => import("../tasks/${s}/web.js")`);
      expect(hub).toContain(`href="/${s}"`);
      expect(existsSync(new URL(`../web/${s}/index.html`, import.meta.url))).toBe(true);
      const page = read(`web/${s}/index.html`);
      expect(page).toContain(`api: "/api/${s}"`);
      expect(page).toContain("Read-only page: no key, nothing signed");
    }
  });
  it("no demo endpoint signs or sends: none imports a signer or a send tool", () => {
    for (const s of SLUGS) {
      const src = read(`tasks/${s}/web.ts`);
      expect(src).not.toMatch(/testnetSigner|lib\/signer|send_raw_transaction|signTransaction|PRIVATE_KEY/);
    }
  });
});
