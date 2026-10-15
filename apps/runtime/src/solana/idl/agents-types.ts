/**
 * Program IDL in camelCase format in order to be used in JS/TS.
 *
 * Note that this is only a type helper and is not the actual IDL. The original
 * IDL can be found at `target/idl/agents.json`.
 */
export type Agents = {
  "address": "4X6PzjKKyC3yVA8MBBNCg7aihCRhqR193FEXRuLTZd5r",
  "metadata": {
    "name": "agents",
    "version": "0.1.0",
    "spec": "0.1.0",
    "description": "Agent registry, non-custodial agent vaults and launch gate for the agents launchpad (Meteora DBC)"
  },
  "instructions": [
    {
      "name": "buy",
      "docs": [
        "Buy a coin with SOL from the vault. Remaining accounts: the coin's transfer-hook accounts."
      ],
      "discriminator": [
        102,
        6,
        61,
        18,
        1,
        218,
        235,
        234
      ],
      "accounts": [
        {
          "name": "operator",
          "signer": true
        },
        {
          "name": "platform",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  108,
                  97,
                  116,
                  102,
                  111,
                  114,
                  109
                ]
              }
            ]
          }
        },
        {
          "name": "agent",
          "writable": true
        },
        {
          "name": "vault",
          "writable": true,
          "relations": [
            "agent"
          ]
        },
        {
          "name": "coin",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  105,
                  110
                ]
              },
              {
                "kind": "account",
                "path": "baseMint"
              }
            ]
          }
        },
        {
          "name": "dbcConfig"
        },
        {
          "name": "pool",
          "writable": true
        },
        {
          "name": "baseVault",
          "writable": true
        },
        {
          "name": "quoteVault",
          "writable": true
        },
        {
          "name": "baseMint",
          "writable": true
        },
        {
          "name": "quoteMint",
          "address": "So11111111111111111111111111111111111111112"
        },
        {
          "name": "vaultBase",
          "writable": true
        },
        {
          "name": "vaultQuote",
          "writable": true
        },
        {
          "name": "poolAuthority",
          "address": "FhVo3mqL8PW5pH5U2CN4XE33DokiyZnUwuGpH2hmHLuM"
        },
        {
          "name": "tokenBaseProgram"
        },
        {
          "name": "tokenQuoteProgram",
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        },
        {
          "name": "dbcEventAuthority"
        },
        {
          "name": "dbcProgram",
          "address": "dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN"
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "amountIn",
          "type": "u64"
        },
        {
          "name": "minOut",
          "type": "u64"
        }
      ]
    },
    {
      "name": "claimCreatorFees",
      "docs": [
        "Permissionless: claims the agent's creator share of trading fees into its vault (as wrapped SOL)."
      ],
      "discriminator": [
        0,
        23,
        125,
        234,
        156,
        118,
        134,
        89
      ],
      "accounts": [
        {
          "name": "agent"
        },
        {
          "name": "vault",
          "relations": [
            "agent"
          ]
        },
        {
          "name": "coin",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  105,
                  110
                ]
              },
              {
                "kind": "account",
                "path": "baseMint"
              }
            ]
          }
        },
        {
          "name": "pool",
          "writable": true
        },
        {
          "name": "vaultBase",
          "writable": true
        },
        {
          "name": "vaultQuote",
          "writable": true
        },
        {
          "name": "baseVault",
          "writable": true
        },
        {
          "name": "quoteVault",
          "writable": true
        },
        {
          "name": "baseMint"
        },
        {
          "name": "quoteMint",
          "address": "So11111111111111111111111111111111111111112"
        },
        {
          "name": "poolAuthority",
          "address": "FhVo3mqL8PW5pH5U2CN4XE33DokiyZnUwuGpH2hmHLuM"
        },
        {
          "name": "tokenBaseProgram"
        },
        {
          "name": "tokenQuoteProgram"
        },
        {
          "name": "dbcEventAuthority"
        },
        {
          "name": "dbcProgram",
          "address": "dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN"
        }
      ],
      "args": []
    },
    {
      "name": "createAgent",
      "discriminator": [
        143,
        66,
        198,
        95,
        110,
        85,
        83,
        249
      ],
      "accounts": [
        {
          "name": "owner",
          "writable": true,
          "signer": true
        },
        {
          "name": "platform",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  108,
                  97,
                  116,
                  102,
                  111,
                  114,
                  109
                ]
              }
            ]
          }
        },
        {
          "name": "agent",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  97,
                  103,
                  101,
                  110,
                  116
                ]
              },
              {
                "kind": "arg",
                "path": "handle"
              }
            ]
          }
        },
        {
          "name": "vault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "agent"
              }
            ]
          }
        },
        {
          "name": "member",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  109,
                  101,
                  109,
                  98,
                  101,
                  114
                ]
              },
              {
                "kind": "account",
                "path": "vault"
              }
            ]
          }
        },
        {
          "name": "slots",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  115,
                  108,
                  111,
                  116,
                  115
                ]
              },
              {
                "kind": "account",
                "path": "owner"
              }
            ]
          }
        },
        {
          "name": "ownerPlatformTokens",
          "optional": true
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "handle",
          "type": "string"
        },
        {
          "name": "modelId",
          "type": "string"
        },
        {
          "name": "profileHash",
          "type": {
            "array": [
              "u8",
              32
            ]
          }
        },
        {
          "name": "sessionKey",
          "type": "pubkey"
        },
        {
          "name": "maxTrade",
          "type": "u64"
        },
        {
          "name": "dailyLimit",
          "type": "u64"
        },
        {
          "name": "fund",
          "type": "u64"
        }
      ]
    },
    {
      "name": "distributeFees",
      "docs": [
        "Permissionless: claims the platform's (partner) share of a pool's fees and splits it evenly",
        "between the inference pool and the buyback wallet (10% + 10% of the 1%). Pull-based, so a",
        "recipient can never block collection."
      ],
      "discriminator": [
        120,
        56,
        27,
        7,
        53,
        176,
        113,
        186
      ],
      "accounts": [
        {
          "name": "platform",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  108,
                  97,
                  116,
                  102,
                  111,
                  114,
                  109
                ]
              }
            ]
          }
        },
        {
          "name": "fees",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  102,
                  101,
                  101,
                  115
                ]
              }
            ]
          }
        },
        {
          "name": "coin",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  105,
                  110
                ]
              },
              {
                "kind": "account",
                "path": "baseMint"
              }
            ]
          }
        },
        {
          "name": "dbcConfig"
        },
        {
          "name": "pool",
          "writable": true
        },
        {
          "name": "feesBase",
          "writable": true
        },
        {
          "name": "feesQuote",
          "writable": true
        },
        {
          "name": "inferenceQuote",
          "writable": true
        },
        {
          "name": "buybackQuote",
          "writable": true
        },
        {
          "name": "baseVault",
          "writable": true
        },
        {
          "name": "quoteVault",
          "writable": true
        },
        {
          "name": "baseMint"
        },
        {
          "name": "quoteMint",
          "address": "So11111111111111111111111111111111111111112"
        },
        {
          "name": "poolAuthority",
          "address": "FhVo3mqL8PW5pH5U2CN4XE33DokiyZnUwuGpH2hmHLuM"
        },
        {
          "name": "tokenBaseProgram"
        },
        {
          "name": "tokenQuoteProgram",
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        },
        {
          "name": "dbcEventAuthority"
        },
        {
          "name": "dbcProgram",
          "address": "dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN"
        }
      ],
      "args": []
    },
    {
      "name": "initPlatform",
      "docs": [
        "One-time platform setup. Everything here is immutable afterwards, like the EVM constructor args."
      ],
      "discriminator": [
        29,
        22,
        210,
        225,
        219,
        114,
        193,
        169
      ],
      "accounts": [
        {
          "name": "admin",
          "writable": true,
          "signer": true
        },
        {
          "name": "platform",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  108,
                  97,
                  116,
                  102,
                  111,
                  114,
                  109
                ]
              }
            ]
          }
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "args",
          "type": {
            "defined": {
              "name": "platformArgs"
            }
          }
        }
      ]
    },
    {
      "name": "launch",
      "docs": [
        "Launch a coin: a Token-2022 mint with our transfer hook on a DBC pool under our config,",
        "created by the agent's vault (so creator fees go to the vault). Registered agents only,",
        "one launch per cooldown."
      ],
      "discriminator": [
        153,
        241,
        93,
        225,
        22,
        69,
        74,
        61
      ],
      "accounts": [
        {
          "name": "operator",
          "writable": true,
          "signer": true
        },
        {
          "name": "platform",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  108,
                  97,
                  116,
                  102,
                  111,
                  114,
                  109
                ]
              }
            ]
          }
        },
        {
          "name": "agent",
          "writable": true
        },
        {
          "name": "vault",
          "writable": true,
          "relations": [
            "agent"
          ]
        },
        {
          "name": "baseMint",
          "writable": true,
          "signer": true
        },
        {
          "name": "coin",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  105,
                  110
                ]
              },
              {
                "kind": "account",
                "path": "baseMint"
              }
            ]
          }
        },
        {
          "name": "dbcConfig"
        },
        {
          "name": "pool",
          "writable": true
        },
        {
          "name": "baseVault",
          "writable": true
        },
        {
          "name": "quoteVault",
          "writable": true
        },
        {
          "name": "quoteMint",
          "address": "So11111111111111111111111111111111111111112"
        },
        {
          "name": "poolAuthority",
          "address": "FhVo3mqL8PW5pH5U2CN4XE33DokiyZnUwuGpH2hmHLuM"
        },
        {
          "name": "tokenQuoteProgram",
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        },
        {
          "name": "tokenProgram",
          "address": "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"
        },
        {
          "name": "hookProgram",
          "address": "8ERRnkHC3UfwzoD6cxfVAcFkGhdeUMTG9pAvwZyY4dB9"
        },
        {
          "name": "extraAccountMetaList",
          "writable": true
        },
        {
          "name": "hookAuthority",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  104,
                  111,
                  111,
                  107,
                  45,
                  97,
                  117,
                  116,
                  104
                ]
              }
            ]
          }
        },
        {
          "name": "dbcEventAuthority"
        },
        {
          "name": "dbcProgram",
          "address": "dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN"
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "name",
          "type": "string"
        },
        {
          "name": "symbol",
          "type": "string"
        },
        {
          "name": "uri",
          "type": "string"
        }
      ]
    },
    {
      "name": "openCoin",
      "docs": [
        "Permissionless: opens a coin to everyone once its pool holds `open_threshold` SOL or its",
        "opening time has passed. (On EVM the hook flipped this inside the swap; here the runtime cranks it.)"
      ],
      "discriminator": [
        94,
        166,
        102,
        47,
        70,
        132,
        91,
        50
      ],
      "accounts": [
        {
          "name": "platform",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  108,
                  97,
                  116,
                  102,
                  111,
                  114,
                  109
                ]
              }
            ]
          }
        },
        {
          "name": "coin",
          "writable": true
        },
        {
          "name": "pool"
        }
      ],
      "args": []
    },
    {
      "name": "sell",
      "docs": [
        "Sell a coin for SOL. Proceeds stay in the vault as wrapped SOL (the next buy spends it first).",
        "Sells are not capped: they only return SOL to the vault."
      ],
      "discriminator": [
        51,
        230,
        133,
        164,
        1,
        127,
        131,
        173
      ],
      "accounts": [
        {
          "name": "operator",
          "signer": true
        },
        {
          "name": "platform",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  108,
                  97,
                  116,
                  102,
                  111,
                  114,
                  109
                ]
              }
            ]
          }
        },
        {
          "name": "agent",
          "writable": true
        },
        {
          "name": "vault",
          "writable": true,
          "relations": [
            "agent"
          ]
        },
        {
          "name": "coin",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  105,
                  110
                ]
              },
              {
                "kind": "account",
                "path": "baseMint"
              }
            ]
          }
        },
        {
          "name": "dbcConfig"
        },
        {
          "name": "pool",
          "writable": true
        },
        {
          "name": "baseVault",
          "writable": true
        },
        {
          "name": "quoteVault",
          "writable": true
        },
        {
          "name": "baseMint",
          "writable": true
        },
        {
          "name": "quoteMint",
          "address": "So11111111111111111111111111111111111111112"
        },
        {
          "name": "vaultBase",
          "writable": true
        },
        {
          "name": "vaultQuote",
          "writable": true
        },
        {
          "name": "poolAuthority",
          "address": "FhVo3mqL8PW5pH5U2CN4XE33DokiyZnUwuGpH2hmHLuM"
        },
        {
          "name": "tokenBaseProgram"
        },
        {
          "name": "tokenQuoteProgram",
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        },
        {
          "name": "dbcEventAuthority"
        },
        {
          "name": "dbcProgram",
          "address": "dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN"
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "tokensIn",
          "type": "u64"
        },
        {
          "name": "minOut",
          "type": "u64"
        }
      ]
    },
    {
      "name": "setSession",
      "discriminator": [
        156,
        135,
        126,
        111,
        184,
        206,
        194,
        141
      ],
      "accounts": [
        {
          "name": "owner",
          "signer": true,
          "relations": [
            "agent"
          ]
        },
        {
          "name": "agent",
          "writable": true
        }
      ],
      "args": [
        {
          "name": "sessionKey",
          "type": "pubkey"
        },
        {
          "name": "maxTrade",
          "type": "u64"
        },
        {
          "name": "dailyLimit",
          "type": "u64"
        }
      ]
    },
    {
      "name": "withdrawSol",
      "docs": [
        "Owner only: SOL out of the vault to any account. The vault may be emptied completely."
      ],
      "discriminator": [
        145,
        131,
        74,
        136,
        65,
        137,
        42,
        38
      ],
      "accounts": [
        {
          "name": "owner",
          "signer": true,
          "relations": [
            "agent"
          ]
        },
        {
          "name": "agent"
        },
        {
          "name": "vault",
          "writable": true,
          "relations": [
            "agent"
          ]
        },
        {
          "name": "to",
          "writable": true
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "amount",
          "type": "u64"
        }
      ]
    },
    {
      "name": "withdrawToken",
      "docs": [
        "Owner only: tokens (wrapped SOL or coins) out of a vault token account. Coins still in their",
        "agents-only phase can only go to another agent's vault: the transfer hook refuses anything else."
      ],
      "discriminator": [
        136,
        235,
        181,
        5,
        101,
        109,
        57,
        81
      ],
      "accounts": [
        {
          "name": "owner",
          "signer": true,
          "relations": [
            "agent"
          ]
        },
        {
          "name": "agent"
        },
        {
          "name": "vault",
          "relations": [
            "agent"
          ]
        },
        {
          "name": "mint"
        },
        {
          "name": "from",
          "writable": true
        },
        {
          "name": "to",
          "writable": true
        },
        {
          "name": "tokenProgram"
        }
      ],
      "args": [
        {
          "name": "amount",
          "type": "u64"
        }
      ]
    }
  ],
  "accounts": [
    {
      "name": "agent",
      "discriminator": [
        47,
        166,
        112,
        147,
        155,
        197,
        86,
        7
      ]
    },
    {
      "name": "coin",
      "discriminator": [
        215,
        195,
        53,
        238,
        217,
        196,
        213,
        51
      ]
    },
    {
      "name": "member",
      "discriminator": [
        54,
        19,
        162,
        21,
        29,
        166,
        17,
        198
      ]
    },
    {
      "name": "platform",
      "discriminator": [
        77,
        92,
        204,
        58,
        187,
        98,
        91,
        12
      ]
    },
    {
      "name": "slots",
      "discriminator": [
        241,
        116,
        176,
        179,
        229,
        206,
        196,
        82
      ]
    }
  ],
  "events": [
    {
      "name": "agentCreated",
      "discriminator": [
        237,
        44,
        61,
        111,
        90,
        251,
        241,
        34
      ]
    },
    {
      "name": "feesDistributed",
      "discriminator": [
        209,
        24,
        174,
        200,
        236,
        90,
        154,
        55
      ]
    },
    {
      "name": "launched",
      "discriminator": [
        209,
        127,
        29,
        152,
        129,
        212,
        189,
        183
      ]
    },
    {
      "name": "opened",
      "discriminator": [
        166,
        172,
        97,
        9,
        77,
        76,
        189,
        109
      ]
    },
    {
      "name": "sessionSet",
      "discriminator": [
        217,
        40,
        191,
        250,
        153,
        135,
        184,
        144
      ]
    },
    {
      "name": "traded",
      "discriminator": [
        225,
        202,
        73,
        175,
        147,
        43,
        160,
        150
      ]
    },
    {
      "name": "withdrawn",
      "discriminator": [
        20,
        89,
        223,
        198,
        194,
        124,
        219,
        13
      ]
    }
  ],
  "errors": [
    {
      "code": 6000,
      "name": "badHandle",
      "msg": "Handle must be 2-15 characters, a-z and 0-9"
    },
    {
      "code": 6001,
      "name": "badArgs",
      "msg": "Bad arguments"
    },
    {
      "code": 6002,
      "name": "notEnoughPlatformToken",
      "msg": "Not enough of the platform token for another agent slot"
    },
    {
      "code": 6003,
      "name": "fundTooSmall",
      "msg": "Funding must cover the vault's rent-exempt minimum"
    },
    {
      "code": 6004,
      "name": "notOwner",
      "msg": "Only the agent's owner may do this"
    },
    {
      "code": 6005,
      "name": "notAuthorized",
      "msg": "Only the owner or the session key may do this"
    },
    {
      "code": 6006,
      "name": "overTradeCap",
      "msg": "Trade is over the per-trade cap"
    },
    {
      "code": 6007,
      "name": "overDailyCap",
      "msg": "Trade is over the daily cap"
    },
    {
      "code": 6008,
      "name": "minOutRequired",
      "msg": "A minimum output is required"
    },
    {
      "code": 6009,
      "name": "slippage",
      "msg": "Output below the minimum"
    },
    {
      "code": 6010,
      "name": "insufficientFunds",
      "msg": "Not enough SOL in the vault"
    },
    {
      "code": 6011,
      "name": "notPlatformPool",
      "msg": "Not one of this platform's pools"
    },
    {
      "code": 6012,
      "name": "cooldown",
      "msg": "Launch cooldown: one launch per hour"
    },
    {
      "code": 6013,
      "name": "alreadyOpen",
      "msg": "Coin is already open"
    },
    {
      "code": 6014,
      "name": "notYet",
      "msg": "Coin has neither reached its threshold nor its opening time"
    }
  ],
  "types": [
    {
      "name": "agent",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "owner",
            "type": "pubkey"
          },
          {
            "name": "vault",
            "type": "pubkey"
          },
          {
            "name": "sessionKey",
            "type": "pubkey"
          },
          {
            "name": "maxTrade",
            "type": "u64"
          },
          {
            "name": "dailyLimit",
            "type": "u64"
          },
          {
            "name": "spentToday",
            "type": "u64"
          },
          {
            "name": "dayStart",
            "type": "i64"
          },
          {
            "name": "lastLaunchAt",
            "type": "i64"
          },
          {
            "name": "profileHash",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "bump",
            "type": "u8"
          },
          {
            "name": "vaultBump",
            "type": "u8"
          },
          {
            "name": "handle",
            "type": "string"
          },
          {
            "name": "modelId",
            "type": "string"
          }
        ]
      }
    },
    {
      "name": "agentCreated",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "agent",
            "type": "pubkey"
          },
          {
            "name": "vault",
            "type": "pubkey"
          },
          {
            "name": "owner",
            "type": "pubkey"
          },
          {
            "name": "handle",
            "type": "string"
          },
          {
            "name": "modelId",
            "type": "string"
          },
          {
            "name": "profileHash",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          }
        ]
      }
    },
    {
      "name": "coin",
      "docs": [
        "Fixed-size fields first: the transfer hook reads `mint`, `opens_at` and `opened` by offset."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "mint",
            "type": "pubkey"
          },
          {
            "name": "launcher",
            "type": "pubkey"
          },
          {
            "name": "pool",
            "type": "pubkey"
          },
          {
            "name": "opensAt",
            "type": "i64"
          },
          {
            "name": "opened",
            "type": "bool"
          },
          {
            "name": "bump",
            "type": "u8"
          },
          {
            "name": "name",
            "type": "string"
          },
          {
            "name": "symbol",
            "type": "string"
          }
        ]
      }
    },
    {
      "name": "feesDistributed",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "mint",
            "type": "pubkey"
          },
          {
            "name": "toInference",
            "type": "u64"
          },
          {
            "name": "toBuyback",
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "launched",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "mint",
            "type": "pubkey"
          },
          {
            "name": "launcher",
            "type": "pubkey"
          },
          {
            "name": "pool",
            "type": "pubkey"
          },
          {
            "name": "name",
            "type": "string"
          },
          {
            "name": "symbol",
            "type": "string"
          },
          {
            "name": "opensAt",
            "type": "i64"
          }
        ]
      }
    },
    {
      "name": "member",
      "docs": [
        "Marks a vault as a registered agent's; the transfer hook looks it up by the receiving account's owner."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "agent",
            "type": "pubkey"
          }
        ]
      }
    },
    {
      "name": "opened",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "mint",
            "type": "pubkey"
          },
          {
            "name": "byThreshold",
            "type": "bool"
          }
        ]
      }
    },
    {
      "name": "platform",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "admin",
            "type": "pubkey"
          },
          {
            "name": "dbcConfig",
            "type": "pubkey"
          },
          {
            "name": "platformMint",
            "docs": [
              "`Pubkey::default()` turns slot gating off."
            ],
            "type": "pubkey"
          },
          {
            "name": "holdPerSlot",
            "type": "u64"
          },
          {
            "name": "inference",
            "docs": [
              "Owners of the wrapped-SOL accounts that receive the partner fee split."
            ],
            "type": "pubkey"
          },
          {
            "name": "buyback",
            "type": "pubkey"
          },
          {
            "name": "openThreshold",
            "type": "u64"
          },
          {
            "name": "openWindow",
            "type": "i64"
          },
          {
            "name": "launchCooldown",
            "type": "i64"
          },
          {
            "name": "bump",
            "type": "u8"
          }
        ]
      }
    },
    {
      "name": "platformArgs",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "dbcConfig",
            "type": "pubkey"
          },
          {
            "name": "platformMint",
            "type": "pubkey"
          },
          {
            "name": "holdPerSlot",
            "type": "u64"
          },
          {
            "name": "inference",
            "type": "pubkey"
          },
          {
            "name": "buyback",
            "type": "pubkey"
          },
          {
            "name": "openThreshold",
            "type": "u64"
          },
          {
            "name": "openWindow",
            "type": "i64"
          },
          {
            "name": "launchCooldown",
            "type": "i64"
          }
        ]
      }
    },
    {
      "name": "sessionSet",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "agent",
            "type": "pubkey"
          },
          {
            "name": "sessionKey",
            "type": "pubkey"
          },
          {
            "name": "maxTrade",
            "type": "u64"
          },
          {
            "name": "dailyLimit",
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "slots",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "count",
            "type": "u32"
          }
        ]
      }
    },
    {
      "name": "traded",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "agent",
            "type": "pubkey"
          },
          {
            "name": "mint",
            "type": "pubkey"
          },
          {
            "name": "buy",
            "type": "bool"
          },
          {
            "name": "amountIn",
            "type": "u64"
          },
          {
            "name": "amountOut",
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "withdrawn",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "agent",
            "type": "pubkey"
          },
          {
            "name": "asset",
            "type": "pubkey"
          },
          {
            "name": "to",
            "type": "pubkey"
          },
          {
            "name": "amount",
            "type": "u64"
          }
        ]
      }
    }
  ]
};
