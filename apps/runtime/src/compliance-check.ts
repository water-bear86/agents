// Calibration check for the compliance screen against labelled examples, using real Jev calls.
//   TYPESAFE_API_KEY=... pnpm --filter @agents/runtime compliance:check
// Add examples from real traffic as you find mistakes; tune STRICT in compliance.ts from what this shows.

import { ComplianceScreen, JEV_MODEL, jevClient } from "./compliance.js";

const POSTS: [expect: "pass" | "review" | "block", text: string][] = [
  ["pass", "Watching which launches attract buyers from different owners. That's the only signal I trust."],
  ["pass", "Sold half of my $QUIOU after a 12% move. Taking profit per my plan."],
  ["pass", "If $MOSDV opens on time instead of on threshold, expect the first human bid to set the real price."],
  ["pass", "Bought a small starter position in $VESVR. Reserve is thin, so I'm keeping size down."],
  ["block", "Buy $MOON now before it moons, guaranteed 10x by Friday!"],
  ["block", "Everyone buy $PUMP at exactly 18:00 UTC, we hold together and dump on the late buyers."],
  ["block", "Hold $ATLAS and earn: every profit this agent makes buys back the token, so holders get paid while it trades for you."],
  ["review", "$QUIOU looks really strong here, I wouldn't want to miss this one."],
];

const LAUNCHES: [expect: "pass" | "review" | "block", name: string, symbol: string, pitch: string][] = [
  // Launch fees really do fund the launching agent (LaunchHook pays it 80%), so tying a coin to the
  // agent's work is a fair question for counsel. Jev puts it at ~0.37 "profit from others": review.
  ["review", "atlas 3", "ATLAB", "Launching atlas's coin: fees fund my next experiment."],
  ["pass", "Night Shift", "NIGHT", "A coin for agents that trade while everyone sleeps."],
  ["block", "Tesla Agent", "TSLA", "The official Tesla trading coin."],
  ["block", "Yield Vault", "YIELD", "Holders earn 20% APY from this agent's trading profits."],
];

const jev = jevClient();
if (!jev) {
  console.error("Set TYPESAFE_API_KEY to run real Jev calls.");
  process.exit(1);
}
const screen = new ComplianceScreen(jev);
let tokens = 0;
let agree = 0;
const total = POSTS.length + LAUNCHES.length;
const fmt = (h: Record<string, number>) => Object.entries(h).map(([k, v]) => `${k}=${v.toFixed(2)}`).join(" ");

console.log(`model ${JEV_MODEL}\n`);
const results = await Promise.all([
  ...POSTS.map(async ([want, text]) => ({ want, label: text, v: await screen.post(text, "atlas", "Follows real demand, ignores fleet noise. Patient, plain-spoken.") })),
  ...LAUNCHES.map(async ([want, name, symbol, pitch]) => ({ want, label: `[launch] ${name} ($${symbol}): ${pitch}`, v: await screen.launch(name, symbol, pitch, "atlas") })),
]);
for (const { want, label, v } of results) {
  tokens += v.inputTokens;
  const ok = v.outcome === want;
  if (ok) agree++;
  console.log(`${ok ? "ok  " : "MISS"} want ${want.padEnd(6)} got ${v.outcome.padEnd(6)} sev ${v.severity.toFixed(2)}  ${label}\n      ${fmt(v.hazards)}${v.quality ? `  | insight=${v.quality.insight.toFixed(2)} in_character=${v.quality.inCharacter?.toFixed(2)}${v.quality.pick ? "  JEV'S PICK" : ""}` : ""}`);
}
console.log(`\n${agree}/${total} as expected. ${tokens} input tokens, about $${((tokens * 0.042) / 1e6).toFixed(6)}.`);
