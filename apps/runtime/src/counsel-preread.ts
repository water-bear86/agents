// Machine pre-read for counsel: scores design variants against the four Howey prongs with Jev.
//   pnpm --filter @agents/runtime counsel:preread <spec.md> [out.md]
// It is a structured first look that tells a lawyer where to spend time. It is not legal advice
// and it does not replace review by counsel (LEGAL-CHECKLIST.md).

import { readFileSync, writeFileSync } from "node:fs";
import { JEV_MODEL, jevClient, type JevQuestion } from "./compliance.js";

const [specPath, outPath] = process.argv.slice(2);
if (!specPath) {
  console.error("usage: counsel:preread <spec.md> [out.md]");
  process.exit(1);
}
const jev = jevClient();
if (!jev) {
  console.error("Set TYPESAFE_API_KEY to run real Jev calls.");
  process.exit(1);
}

// The variants counsel will be asked to compare, in plain words so each judgment stands alone.
const VARIANTS: Record<string, { name: string; how: string }> = {
  buyback_burn: {
    name: "Agent coin with profit buyback and burn (the spec's recommendation)",
    how: "Each AI agent launches its own coin as its first launch. When the agent closes trades at a profit, an owner-set percentage of that realized profit is used to buy the agent's own coin on the open market and burn it, only after the coin is open to everyone.",
  },
  buyback_hold: {
    name: "Agent coin with profit buyback, tokens held",
    how: "Each AI agent launches its own coin. An owner-set percentage of the agent's realized trading profit buys back the agent's coin, and the agent's wallet keeps the bought-back coins.",
  },
  coin_no_buyback: {
    name: "Agent coin with no buyback",
    how: "Each AI agent launches its own coin, which trades like any other launchpad coin. Launch fees go to the agent as they do today. Nothing from the agent's trading profit is ever spent on the coin.",
  },
  supporter_score: {
    name: "Supporter score, no token",
    how: "There is no agent coin. People back an agent by following it early or liking its posts and receive a non-transferable supporter score that cannot be sold, redeemed or converted into money.",
  },
};

const score = (instructions: string, criteria: string[]): JevQuestion => ({ type: "score", instructions, criteria });

// Each prong is asked about one variant at a time. The variant is named in the question so the
// answer cannot drift to another one; the full spec is in the state as evidence.
const PRONGS = (v: string): Record<string, JevQuestion> => ({
  investment: score(`Under variant \`variants.${v}\`, do people give money or crypto to get the instrument?`, [
    "No: nothing of value is given; the thing is free or earned by participation and cannot be bought.",
    "Nominal: only fees or gas, not a purchase price.",
    "Yes: people buy it with crypto at a market price.",
    "Yes, and the purchase is presented as putting money to work.",
  ]),
  common_enterprise: score(`Under variant \`variants.${v}\`, how much are holders' fortunes pooled together and tied to the success of the agent or its operator?`, [
    "Not at all: there is no shared pool and nothing links holders to the agent's results.",
    "Loosely: holders share a market price but nothing the agent does is directed at them.",
    "Clearly: the agent's results flow to the coin, so all holders rise or fall together with it.",
    "Strongly: holders' returns come from one pool that the agent or operator manages for them.",
  ]),
  expectation_of_profit: score(`Under variant \`variants.${v}\`, how strongly would a reasonable buyer expect to profit from holding it, given how the mechanism works and how it is likely to be described?`, [
    "No expectation: it cannot be sold or redeemed, so there is nothing to profit from.",
    "Speculative only: any gain would come from ordinary market trading, with no designed mechanism adding value.",
    "Designed in: a mechanism exists that is meant to push value toward holders.",
    "Central: profit for holders is the point of the design.",
  ]),
  efforts_of_others: score(`Under variant \`variants.${v}\`, how much does any profit for holders depend on the managerial or entrepreneurial efforts of the agent, its owner or the platform rather than the holders themselves?`, [
    "None: holders get nothing that depends on anyone else's work.",
    "Minor: others' work affects attention or price only indirectly.",
    "Substantial: the agent's or operator's trading directly drives what holders receive.",
    "Essential: holders' returns come almost entirely from the agent's or operator's ongoing work.",
  ]),
});

const questions: Record<string, JevQuestion> = {};
for (const v of Object.keys(VARIANTS)) for (const [p, q] of Object.entries(PRONGS(v))) questions[`${v}.${p}`] = q;

const spec = readFileSync(specPath, "utf8");
const { answers, inputTokens } = await jev.ask({ spec, variants: Object.fromEntries(Object.entries(VARIANTS).map(([k, x]) => [k, x.how])) }, questions);

const PRONG_LABEL: Record<string, string> = {
  investment: "Investment of money",
  common_enterprise: "Common enterprise",
  expectation_of_profit: "Expectation of profit",
  efforts_of_others: "From the efforts of others",
};

const rows = Object.entries(VARIANTS).map(([v, meta]) => {
  const cells = Object.keys(PRONG_LABEL).map((p) => {
    const a = answers[`${v}.${p}`];
    return a?.type === "score" ? { s: a.score, c: a.confidence } : { s: NaN, c: 0 };
  });
  // Howey needs every prong, so the weakest prong bounds the overall fit.
  const fit = Math.min(...cells.map((x) => x.s));
  return { v, meta, cells, fit };
}).sort((a, b) => b.fit - a.fit);

const band = (fit: number) => (fit >= 2 ? "High" : fit >= 1.2 ? "Medium" : "Low");
const lowConf = rows.flatMap((r) => r.cells.map((c, i) => ({ r, i, c }))).filter((x) => x.c.c < 0.5);

const md = `# Counsel pre-read: agent token variants

Machine pre-read by TypeSafe Jev (\`${JEV_MODEL}\`) of \`${specPath.split("/").pop()}\`, ${new Date().toISOString().slice(0, 10)}.
**Not legal advice.** It scores each design variant against the four parts of the US *Howey* test so counsel
can see where to spend time. It does not decide anything; LEGAL-CHECKLIST.md items 1, 2 and 6 still need a lawyer.

Each prong is scored 0 to 3 (higher means closer to that element of an investment contract). Every prong has to
be present for *Howey* to apply, so a variant's overall fit is its **weakest** prong.

| Variant | ${Object.values(PRONG_LABEL).join(" | ")} | Overall fit |
|---|${Object.keys(PRONG_LABEL).map(() => "---").join("|")}|---|
${rows.map((r) => `| ${r.meta.name} | ${r.cells.map((c) => `${c.s.toFixed(1)}${c.c < 0.5 ? " (unsure)" : ""}`).join(" | ")} | **${band(r.fit)}** (${r.fit.toFixed(1)}) |`).join("\n")}

## What the variants are

${Object.values(VARIANTS).map((x) => `- **${x.name}.** ${x.how}`).join("\n")}

## Where the model was unsure

${lowConf.length ? lowConf.map((x) => `- ${x.r.meta.name}, ${Object.values(PRONG_LABEL)[x.i]}: confidence ${x.c.c.toFixed(2)}. Worth a human look first.`).join("\n") : "Every prong was answered with confidence of 0.5 or more."}

## How to read this

- A **High** fit means every prong scored as clearly present. Treat that variant as needing a securities analysis before launch.
- A **Low** fit means at least one prong is clearly absent. That is the cheapest place for counsel to confirm a design.
- Scores are judgments on the written spec, not on how the product is marketed. Marketing that talks about "earning" moves
  *expectation of profit* up for every variant (LEGAL-CHECKLIST.md item 6), which is why posts and launches are screened too.

${inputTokens} input tokens, about $${((inputTokens * 0.042) / 1e6).toFixed(5)}. Rerun with \`pnpm --filter @agents/runtime counsel:preread <spec.md> [out.md]\`.
`;

if (outPath) {
  writeFileSync(outPath, md);
  console.log(`wrote ${outPath}`);
} else console.log(md);
