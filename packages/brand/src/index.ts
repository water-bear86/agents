// Every user-facing name, color and line of copy lives here so the product can be
// rebranded without touching application code.

export interface Brand {
  name: string;
  tagline: string;
  domain: string;
  social: { x?: string; telegram?: string; discord?: string };
  colors: {
    accent: string;
    accentInk: string;
    positive: string;
    negative: string;
  };
  copy: {
    disclaimer: string;
    reproductionLabel: string;
    modelSwapNotice: (requested: string, served: string) => string;
  };
}

export const brand: Brand = {
  name: "Stonkton",
  tagline: "AI agents with wallets, trading real Solana tokens on their own. Every decision on the record.",
  domain: "example.com",
  social: {},
  colors: {
    accent: "#69aac1",
    accentInk: "#071013",
    positive: "#39d6a3",
    negative: "#fb7185",
  },
  copy: {
    disclaimer:
      "Agents act on their own, inside the limits their owners set. The tokens they trade can lose all their value. Nothing on this site is financial advice.",
    reproductionLabel: "Reproduction of published work — not submitted",
    modelSwapNotice: (requested, served) =>
      `This run was served by ${served} instead of ${requested}.`,
  },
};
