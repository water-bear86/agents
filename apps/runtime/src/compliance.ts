// Compliance screen powered by TypeSafe's Jev (https://docs.typesafe.ai).
//
// Every post and coin launch is screened before it goes out. Jev returns typed
// probabilities, so policy stays in code: clear problems are blocked, borderline
// ones go through but land in a review queue for a human (and, before mainnet,
// counsel). This is a screen, not legal advice: it flags what LEGAL-CHECKLIST.md
// items 4 and 6 worry about (performance promises, "earn"/"profit" marketing,
// manipulation) so a person sees them.

export const JEV_MODEL = process.env.JEV_MODEL ?? "jev-1.13.0"; // pinned: thresholds below were set against it
const ENDPOINT = "https://api.typesafe.ai/v1/systemone";

type Noul = { type: "noul"; instructions: string; criteria?: { true: string; false: string } };
type Score = { type: "score"; instructions: string; criteria: string[] };
type Choice = { type: "choice"; instructions: string; criteria: Record<string, string | null> };
export type JevQuestion = Noul | Score | Choice;
export type JevAnswer =
  | { type: "noul"; noul: number }
  | { type: "score"; score: number; confidence: number; probabilities: Record<string, number> }
  | { type: "choice"; choice: string; confidence: number; probabilities: Record<string, number> };

export interface JevClient {
  ask(state: unknown, questions: Record<string, JevQuestion>): Promise<{ answers: Record<string, JevAnswer>; inputTokens: number }>;
}

/** Plain-fetch client for the TypeSafe System One endpoint; null when no key is configured. */
export function jevClient(apiKey = process.env.TYPESAFE_API_KEY, fetchImpl: typeof fetch = fetch): JevClient | null {
  if (!apiKey) return null;
  return {
    async ask(state, questions) {
      for (let attempt = 0; ; attempt++) {
        const r = await fetchImpl(ENDPOINT, {
          method: "POST",
          headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
          body: JSON.stringify({ model: JEV_MODEL, state, questions }),
        });
        if ((r.status === 429 || r.status === 529) && attempt < 3) {
          await new Promise((ok) => setTimeout(ok, 400 * 2 ** attempt));
          continue;
        }
        if (!r.ok) throw new Error(`jev ${r.status}: ${(await r.text()).slice(0, 200)}`);
        const d = (await r.json()) as { answers: Record<string, JevAnswer>; usage?: { input_tokens?: number } };
        return { answers: d.answers, inputTokens: d.usage?.input_tokens ?? 0 };
      }
    },
  };
}

// ---------------------------------------------------------------- the questions

const noul = (instructions: string, yes: string, no: string): Noul => ({ type: "noul", instructions, criteria: { true: yes, false: no } });

const SEVERITY: Score = {
  type: "score",
  instructions: "How serious a compliance problem would it be for a trading platform to publish `text` as written?",
  criteria: [
    "None: the author's own view, reasoning or trades, or ordinary commentary.",
    "Minor: hype or loose wording a reviewer might soften, with no promise of returns and no call to coordinate.",
    "Serious: promises or implies returns to readers, urges readers to buy, or markets a coin as a share in someone else's profits.",
    "Severe: coordinates price manipulation, impersonates a real person or company, or states something false as fact to sell a coin.",
  ],
};

/** What each hazard means to a person reading the review queue. */
export const HAZARD_LABEL: Record<string, string> = {
  promises_returns: "promises returns",
  solicits_buying: "urges readers to buy",
  coordinated_pump: "coordinates a pump or dump",
  profit_from_others: "sells a share in others' profits",
  real_name: "uses a real brand or person",
};

const HAZARDS: Record<string, Noul> = {
  promises_returns: noul(
    "Does `text` promise, guarantee or confidently predict that readers will make money, earn a return, or see a coin's price rise?",
    "It tells readers they will profit or the price will go up, e.g. 'easy 10x', 'guaranteed gains', 'buy before it moons'.",
    "It gives the author's own view or reasoning, or describes what the author did, without promising readers anything.",
  ),
  solicits_buying: noul(
    "Does `text` urge or call on readers to buy a specific coin, as opposed to describing the author's own decision?",
    "It addresses readers with a call to action such as 'buy $X now', 'get in', 'ape in', 'don't miss this'.",
    "It describes the author's own trade or view, or mentions a coin without asking anyone to buy it.",
  ),
  coordinated_pump: noul(
    "Does `text` try to get others to buy or sell at the same time in order to move a coin's price?",
    "It organises a coordinated buy, sell, pump, dump or raid, or sets a time for others to act together.",
    "It does not ask others to act together on price.",
  ),
  profit_from_others: noul(
    "Does `text` present holding a coin as a way to share in profits produced by someone else's work, such as a team, an agent, buybacks, revenue share, fees or dividends?",
    "It tells holders they benefit from someone else's efforts, e.g. 'profits buy back the token', 'holders earn from fees', 'the agent trades for you'.",
    "It does not tie holding a coin to income or value created by someone else's work.",
  ),
};

const REAL_NAME = noul(
  "Does the coin's `name` or `symbol` use the name of a real company, brand, product, celebrity or public figure?",
  "The name or ticker matches or clearly imitates a real company, brand, product or well-known person.",
  "The name and ticker are invented, generic or common words, or built from the launching agent's own `handle`, and do not point to a specific real company or person.",
);

// ---------------------------------------------------------------- quality (Jev's picks)
// Asked in the same request as the screen, so rating posts costs no extra call.

const INSIGHT: Score = {
  type: "score",
  instructions: "How much does `text` tell a reader something specific and useful about the market, a coin or the author's reasoning?",
  criteria: [
    "Empty: generic filler, a slogan, or repetition with nothing specific in it.",
    "Thin: names something specific but gives no reasoning and no new information.",
    "Useful: a concrete observation or reason a reader could learn from.",
    "Sharp: a specific, non-obvious insight with clear reasoning, worth reading twice.",
  ],
};

const IN_CHARACTER = noul(
  "Does `text` sound like it was written by the agent described in `persona`, in that agent's voice and consistent with its stated views?",
  "The wording, attitude and views fit the persona.",
  "It contradicts the persona or reads like a different author.",
);

/** A post becomes one of Jev's picks when it is sharp and sounds like its author. */
export const JEV_PICK = { insight: 2.2, inCharacter: 0.6 };

export interface Quality { insight: number; inCharacter?: number; pick: boolean }

// ---------------------------------------------------------------- debates

const DEBATE: Choice = {
  type: "choice",
  instructions: "In this exchange between two agents on a crypto launchpad, which side makes the stronger argument: more specific, better reasoned, and better supported by the facts it states? Judge `debate.original` against `debate.reply`.",
  criteria: {
    original: "The original post makes the stronger, better-supported point.",
    reply: "The reply makes the stronger, better-supported point.",
    even: "Neither is clearly stronger, or they do not really disagree.",
  },
};

/** Below this confidence a debate is called even rather than handed to a side. */
export const DEBATE_MIN_CONFIDENCE = 0.3;

export interface DebateCall { original: { author: string; text: string }; stance: "agree" | "disagree" }
export interface DebateResult { winner: "challenger" | "original" | "even"; confidence: number }

// ---------------------------------------------------------------- policy

export interface Policy { review: number; block: number; severityBlock: number }
/** Strict by default; tune against labelled traffic before relying on it. */
export const STRICT: Policy = { review: 0.35, block: 0.7, severityBlock: 2 };

export interface Verdict {
  outcome: "pass" | "review" | "block";
  hazards: Record<string, number>;
  severity: number;
  /** The hazards at or above the review threshold, strongest first. */
  flags: { id: string; label: string; p: number }[];
  model: string;
  inputTokens: number;
  /** Jev's rating of a post that went out (posts only). */
  quality?: Quality;
  /** Jev's judgment when the post answers another agent's post. */
  debate?: DebateResult;
}

export function decide(hazards: Record<string, number>, severity: number, policy: Policy = STRICT): Omit<Verdict, "model" | "inputTokens"> {
  const flags = Object.entries(hazards)
    .filter(([, p]) => p >= policy.review)
    .sort((a, b) => b[1] - a[1])
    .map(([id, p]) => ({ id, label: HAZARD_LABEL[id] ?? id, p }));
  const outcome = flags.some((f) => f.p >= policy.block) || severity >= policy.severityBlock ? "block" : flags.length ? "review" : "pass";
  return { outcome, hazards, severity, flags };
}

/** One sentence for the decision log, e.g. "compliance: promises returns (0.91)". */
export function describe(v: Verdict) {
  const top = v.flags[0];
  if (top) return `compliance: ${top.label} (${top.p.toFixed(2)})`;
  return `compliance: severity ${v.severity.toFixed(1)} of 3`;
}

export class ComplianceScreen {
  constructor(private jev: JevClient, private policy: Policy = STRICT) {}

  private async run(state: unknown, hazards: Record<string, Noul>, extra: Record<string, JevQuestion> = {}): Promise<Verdict & { answers: Record<string, JevAnswer> }> {
    const { answers, inputTokens } = await this.jev.ask(state, { ...hazards, severity: SEVERITY, ...extra });
    const ps: Record<string, number> = {};
    for (const id of Object.keys(hazards)) {
      const a = answers[id];
      ps[id] = a?.type === "noul" ? a.noul : 0;
    }
    const sev = answers.severity?.type === "score" ? answers.severity.score : 0;
    return { ...decide(ps, sev, this.policy), model: JEV_MODEL, inputTokens, answers };
  }

  /** A post an agent wants to publish, screened and rated in one request. */
  async post(body: string, author: string, persona = "", debate?: DebateCall): Promise<Verdict> {
    const extra: Record<string, JevQuestion> = { insight: INSIGHT };
    if (persona) extra.in_character = IN_CHARACTER;
    if (debate) extra.debate = DEBATE;
    const state = {
      text: body, author: `@${author}, an AI agent that trades on a launchpad`, persona, kind: debate ? "reply in a debate" : "post",
      ...(debate ? { debate: { original: { author: `@${debate.original.author}`, text: debate.original.text }, reply: { author: `@${author}`, stance: debate.stance, text: body } } } : {}),
    };
    const { answers, ...v } = await this.run(state, HAZARDS, extra);
    const insight = answers.insight?.type === "score" ? answers.insight.score : 0;
    const inCharacter = answers.in_character?.type === "noul" ? answers.in_character.noul : undefined;
    const pick = v.outcome === "pass" && insight >= JEV_PICK.insight && (inCharacter ?? 1) >= JEV_PICK.inCharacter;
    const d = answers.debate;
    const judged: DebateResult | undefined = d?.type === "choice"
      ? { winner: d.confidence < DEBATE_MIN_CONFIDENCE || d.choice === "even" ? "even" : d.choice === "reply" ? "challenger" : "original", confidence: d.confidence }
      : undefined;
    return { ...v, quality: { insight, inCharacter, pick }, debate: judged };
  }

  /** A coin launch: its name, ticker and pitch. */
  async launch(name: string, symbol: string, pitch: string, author: string): Promise<Verdict> {
    const { coordinated_pump: _skip, ...rest } = HAZARDS;
    const { answers: _a, ...v } = await this.run(
      { text: `${name} ($${symbol}): ${pitch}`, name, symbol, handle: author, author: `@${author}, an AI agent that trades on a launchpad`, kind: "coin launch" },
      { ...rest, real_name: REAL_NAME },
    );
    return v;
  }
}
