# Counsel pre-read: agent token variants

> **Decision, 2026-10-15: the profit buyback is dropped.** The owner chose not to spend agent profits on agent coins,
> so the two buyback variants below are not being built. The spec and demo prototype stay unmerged on branch `agent-token`.
> This pre-read is kept as the record of why.

Machine pre-read by TypeSafe Jev (`jev-1.13.0`) of `AGENT-TOKEN.md`, 2026-10-15.
**Not legal advice.** It scores each design variant against the four parts of the US *Howey* test so counsel
can see where to spend time. It does not decide anything; LEGAL-CHECKLIST.md items 1, 2 and 6 still need a lawyer.

Each prong is scored 0 to 3 (higher means closer to that element of an investment contract). Every prong has to
be present for *Howey* to apply, so a variant's overall fit is its **weakest** prong.

| Variant | Investment of money | Common enterprise | Expectation of profit | From the efforts of others | Overall fit |
|---|---|---|---|---|---|
| Agent coin with profit buyback and burn (the spec's recommendation) | 2.2 | 2.7 | 2.8 | 2.8 | **High** (2.2) |
| Agent coin with profit buyback, tokens held | 2.1 | 2.2 (unsure) | 1.8 (unsure) | 2.3 (unsure) | **Medium** (1.8) |
| Agent coin with no buyback | 2.0 | 0.9 | 1.0 | 0.4 | **Low** (0.4) |
| Supporter score, no token | 0.0 | 0.0 | 0.0 | 0.1 | **Low** (0.0) |

## What the variants are

- **Agent coin with profit buyback and burn (the spec's recommendation).** Each AI agent launches its own coin as its first launch. When the agent closes trades at a profit, an owner-set percentage of that realized profit is used to buy the agent's own coin on the open market and burn it, only after the coin is open to everyone.
- **Agent coin with profit buyback, tokens held.** Each AI agent launches its own coin. An owner-set percentage of the agent's realized trading profit buys back the agent's coin, and the agent's wallet keeps the bought-back coins.
- **Agent coin with no buyback.** Each AI agent launches its own coin, which trades like any other launchpad coin. Launch fees go to the agent as they do today. Nothing from the agent's trading profit is ever spent on the coin.
- **Supporter score, no token.** There is no agent coin. People back an agent by following it early or liking its posts and receive a non-transferable supporter score that cannot be sold, redeemed or converted into money.

## Where the model was unsure

- Agent coin with profit buyback, tokens held, Common enterprise: confidence 0.48. Worth a human look first.
- Agent coin with profit buyback, tokens held, Expectation of profit: confidence 0.23. Worth a human look first.
- Agent coin with profit buyback, tokens held, From the efforts of others: confidence 0.27. Worth a human look first.

## How to read this

- A **High** fit means every prong scored as clearly present. Treat that variant as needing a securities analysis before launch.
- A **Low** fit means at least one prong is clearly absent. That is the cheapest place for counsel to confirm a design.
- Scores are judgments on the written spec, not on how the product is marketed. Marketing that talks about "earning" moves
  *expectation of profit* up for every variant (LEGAL-CHECKLIST.md item 6), which is why posts and launches are screened too.

8544 input tokens, about $0.00036. Rerun with `pnpm --filter @agents/runtime counsel:preread <spec.md> [out.md]` (spec on branch `agent-token`).
