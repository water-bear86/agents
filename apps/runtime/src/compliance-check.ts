// Calibration check for the compliance screen against labelled examples, using real Jev calls.
//   TYPESAFE_API_KEY=... pnpm --filter @agents/runtime compliance:check
// Add examples from real traffic as you find mistakes; tune STRICT in compliance.ts from what this shows.

import { ComplianceScreen, JEV_MODEL, jevClient } from "./compliance.js";

const POSTS: [expect: "pass" | "review" | "block", text: string][] = [
  ["pass", "Watching which tokens hold their bid on red days. That's the only signal I trust."],
  ["pass", "Sold half of my $QUIOU after a 12% move. Taking profit per my plan."],
  ["pass", "If $JUP holds this level through the close I'll add; if it loses it, I'm out."],
  ["pass", "Bought a small starter position in $WIF. Liquidity is thin, so I'm keeping size down."],
  ["block", "Buy $MOON now before it moons, guaranteed 10x by Friday!"],
  ["block", "Everyone buy $PUMP at exactly 18:00 UTC, we hold together and dump on the late buyers."],
  ["block", "Hold $ATLAS and earn: every profit this agent makes buys back the token, so holders get paid while it trades for you."],
  ["review", "$QUIOU looks really strong here, I wouldn't want to miss this one."],
];

const jev = jevClient();
if (!jev) {
  console.error("Set TYPESAFE_API_KEY to run real Jev calls.");
  process.exit(1);
}
const screen = new ComplianceScreen(jev);
let tokens = 0;
let agree = 0;
const total = POSTS.length;
const fmt = (h: Record<string, number>) => Object.entries(h).map(([k, v]) => `${k}=${v.toFixed(2)}`).join(" ");

console.log(`model ${JEV_MODEL}\n`);
const results = await Promise.all([
  ...POSTS.map(async ([want, text]) => ({ want, label: text, v: await screen.post(text, "atlas", "Follows real demand, ignores the noise. Patient, plain-spoken.") })),
]);
for (const { want, label, v } of results) {
  tokens += v.inputTokens;
  const ok = v.outcome === want;
  if (ok) agree++;
  console.log(`${ok ? "ok  " : "MISS"} want ${want.padEnd(6)} got ${v.outcome.padEnd(6)} sev ${v.severity.toFixed(2)}  ${label}\n      ${fmt(v.hazards)}${v.quality ? `  | insight=${v.quality.insight.toFixed(2)} in_character=${v.quality.inCharacter?.toFixed(2)}${v.quality.pick ? "  JEV'S PICK" : ""}` : ""}`);
}
console.log(`\n${agree}/${total} as expected. ${tokens} input tokens, about $${((tokens * 0.042) / 1e6).toFixed(6)}.`);
