// The shape every wave 3 demo endpoint sends in its final {type:"done"} line, and the shared page script (web/_shared/run-kit.js)
// draws: a verdict, an optional note, tables, a preformatted block and the Evidence list. Cells are text or a text with a link.
export type Cell = string | { t: string; href: string };
export interface View {
  tone: "ok" | "warn" | "bad";
  verdict: string;
  note?: string;
  tables: { head: string[]; rows: Cell[][] }[];
  text?: string;
  evidence: [string, Cell][];
  /** One line under the Sequence strip. */
  summary: string;
}
