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
    "description": "Agent registry and non-custodial agent vaults: owners fund and withdraw, a session key trades through Jupiter within caps"
  },
  "instructions": [
    {
      "name": "acceptAdmin",
      "discriminator": [
        112,
        42,
        45,
        90,
        116,
        181,
        13,
        170
      ],
      "accounts": [
        {
          "name": "pendingAdmin",
          "signer": true,
          "relations": [
            "platform"
          ]
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
        }
      ],
      "args": []
    },
    {
      "name": "allowMint",
      "docs": [
        "Adds a token, with its Pyth USD price feed, to the whitelist session keys may trade."
      ],
      "discriminator": [
        240,
        28,
        240,
        70,
        124,
        240,
        245,
        225
      ],
      "accounts": [
        {
          "name": "admin",
          "writable": true,
          "signer": true,
          "relations": [
            "platform"
          ]
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
          "name": "mint",
          "docs": [
            "Plain SPL tokens only: Token-2022 extensions (permanent delegate, transfer hook, pausing)",
            "could take or trap what session keys buy."
          ]
        },
        {
          "name": "allowed",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  109,
                  105,
                  110,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "mint"
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
          "name": "feed",
          "type": {
            "array": [
              "u8",
              32
            ]
          }
        }
      ]
    },
    {
      "name": "closeTokenAccount",
      "docs": [
        "Owner or session key: closes a vault token account, sending its rent (and, for wrapped",
        "SOL, its balance) back to the vault. Other tokens must be empty first."
      ],
      "discriminator": [
        132,
        172,
        24,
        60,
        100,
        156,
        135,
        97
      ],
      "accounts": [
        {
          "name": "operator",
          "signer": true
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
          "name": "account",
          "writable": true
        },
        {
          "name": "tokenProgram"
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
      "name": "disallowMint",
      "docs": [
        "Takes a token off the whitelist. Session keys can then neither buy nor sell it; owners still can."
      ],
      "discriminator": [
        75,
        176,
        193,
        187,
        34,
        158,
        118,
        121
      ],
      "accounts": [
        {
          "name": "admin",
          "writable": true,
          "signer": true,
          "relations": [
            "platform"
          ]
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
          "name": "allowed",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  109,
                  105,
                  110,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "allowed.mint",
                "account": "allowedMint"
              }
            ]
          }
        }
      ],
      "args": []
    },
    {
      "name": "initPlatform",
      "docs": [
        "One-time setup by the program's upgrade authority, so nobody can front-run it."
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
          "docs": [
            "Must be the program's upgrade authority."
          ],
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
          "name": "program",
          "address": "4X6PzjKKyC3yVA8MBBNCg7aihCRhqR193FEXRuLTZd5r"
        },
        {
          "name": "programData"
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "oracle",
          "type": {
            "defined": {
              "name": "oracleSettings"
            }
          }
        }
      ]
    },
    {
      "name": "setAdmin",
      "docs": [
        "Proposes a new admin, who takes over by calling `accept_admin`, so a mistyped key can't",
        "lock the whitelist and pause switch away for good."
      ],
      "discriminator": [
        251,
        163,
        0,
        52,
        91,
        194,
        187,
        92
      ],
      "accounts": [
        {
          "name": "admin",
          "signer": true,
          "relations": [
            "platform"
          ]
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
        }
      ],
      "args": [
        {
          "name": "admin",
          "type": "pubkey"
        }
      ]
    },
    {
      "name": "setOracle",
      "docs": [
        "How old a price may be, and how far below the oracle price a session-key swap may fill."
      ],
      "discriminator": [
        186,
        128,
        81,
        104,
        74,
        79,
        18,
        224
      ],
      "accounts": [
        {
          "name": "admin",
          "signer": true,
          "relations": [
            "platform"
          ]
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
        }
      ],
      "args": [
        {
          "name": "oracle",
          "type": {
            "defined": {
              "name": "oracleSettings"
            }
          }
        }
      ]
    },
    {
      "name": "setPaused",
      "docs": [
        "Stops (or restarts) every session key's trading. Owners can always trade and withdraw."
      ],
      "discriminator": [
        91,
        60,
        125,
        192,
        176,
        225,
        166,
        218
      ],
      "accounts": [
        {
          "name": "admin",
          "signer": true,
          "relations": [
            "platform"
          ]
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
        }
      ],
      "args": [
        {
          "name": "paused",
          "type": "bool"
        }
      ]
    },
    {
      "name": "setSession",
      "docs": [
        "Owner only: replace or revoke (Pubkey::default()) the session key and its caps."
      ],
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
      "name": "swap",
      "docs": [
        "Swap through Jupiter from one vault token account to another. `route` is the Jupiter",
        "instruction data; remaining accounts are its accounts, in order.",
        "",
        "Session key: only between SOL and a whitelisted token, at no worse than the oracle price",
        "less the platform's maximum slippage; buys spend wrapped SOL (topped up from the vault's",
        "SOL) within the caps. The owner may swap anything."
      ],
      "discriminator": [
        248,
        198,
        158,
        145,
        225,
        117,
        135,
        200
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
          "name": "vaultInput",
          "writable": true
        },
        {
          "name": "vaultOutput",
          "writable": true
        },
        {
          "name": "allowed",
          "docs": [
            "The whitelist entry for the token traded (the one that isn't SOL); required for the session key."
          ],
          "optional": true
        },
        {
          "name": "solPrice",
          "docs": [
            "Pyth price updates for SOL/USD and the token; required for the session key."
          ],
          "optional": true
        },
        {
          "name": "tokenPrice",
          "optional": true
        },
        {
          "name": "jupiterProgram",
          "address": "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4"
        },
        {
          "name": "tokenProgram",
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
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
        },
        {
          "name": "route",
          "type": "bytes"
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
        "Owner only: tokens out of a vault token account to any token account. Remaining accounts:",
        "the mint's transfer-hook accounts, if it has a hook (Token-2022 matches them by key)."
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
      "name": "allowedMint",
      "discriminator": [
        173,
        229,
        179,
        46,
        121,
        164,
        247,
        6
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
      "name": "priceUpdateV2",
      "discriminator": [
        34,
        241,
        35,
        99,
        157,
        126,
        244,
        205
      ]
    }
  ],
  "events": [
    {
      "name": "adminSet",
      "discriminator": [
        157,
        245,
        205,
        226,
        118,
        125,
        183,
        97
      ]
    },
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
      "name": "mintAllowed",
      "discriminator": [
        80,
        212,
        130,
        120,
        125,
        216,
        111,
        240
      ]
    },
    {
      "name": "pausedSet",
      "discriminator": [
        171,
        125,
        127,
        156,
        233,
        81,
        68,
        66
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
      "name": "swapped",
      "discriminator": [
        217,
        52,
        52,
        83,
        147,
        135,
        96,
        109
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
      "name": "fundTooSmall",
      "msg": "Funding must cover the vault's rent-exempt minimum"
    },
    {
      "code": 6003,
      "name": "notOwner",
      "msg": "Only the agent's owner may do this"
    },
    {
      "code": 6004,
      "name": "notAuthorized",
      "msg": "Only the owner or the session key may do this"
    },
    {
      "code": 6005,
      "name": "notAdmin",
      "msg": "Only the platform admin may do this"
    },
    {
      "code": 6006,
      "name": "paused",
      "msg": "Session-key trading is paused"
    },
    {
      "code": 6007,
      "name": "notWhitelisted",
      "msg": "Session keys may only buy whitelisted tokens"
    },
    {
      "code": 6008,
      "name": "sellsToSolOnly",
      "msg": "Session keys may only sell back to SOL"
    },
    {
      "code": 6009,
      "name": "overTradeCap",
      "msg": "Trade is over the per-trade cap"
    },
    {
      "code": 6010,
      "name": "overDailyCap",
      "msg": "Trade is over the daily cap"
    },
    {
      "code": 6011,
      "name": "minOutRequired",
      "msg": "A minimum output is required"
    },
    {
      "code": 6012,
      "name": "slippage",
      "msg": "Output below the minimum"
    },
    {
      "code": 6013,
      "name": "insufficientFunds",
      "msg": "Not enough SOL in the vault"
    },
    {
      "code": 6014,
      "name": "badRoute",
      "msg": "Only Jupiter's exact-in routes from and to this vault are accepted"
    },
    {
      "code": 6015,
      "name": "routeTakesFee",
      "msg": "Routes may not take a platform fee or positive slippage"
    },
    {
      "code": 6016,
      "name": "routeMovedFunds",
      "msg": "The route moved vault funds it wasn't allowed to"
    },
    {
      "code": 6017,
      "name": "priceRequired",
      "msg": "Session-key swaps need the SOL and token price accounts"
    },
    {
      "code": 6018,
      "name": "badPrice",
      "msg": "Oracle price missing, stale, for the wrong feed, or out of range"
    },
    {
      "code": 6019,
      "name": "belowOraclePrice",
      "msg": "Output below the oracle price less the maximum slippage"
    },
    {
      "code": 6020,
      "name": "notEmpty",
      "msg": "Token account must be empty to close"
    },
    {
      "code": 6021,
      "name": "notUpgradeAuthority",
      "msg": "Only the program's upgrade authority can set up the platform"
    }
  ],
  "types": [
    {
      "name": "adminSet",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "admin",
            "type": "pubkey"
          }
        ]
      }
    },
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
            "name": "spent",
            "docs": [
              "SOL the session key has spent, as of `spent_at`; it refills at `daily_limit` per day."
            ],
            "type": "u64"
          },
          {
            "name": "spentAt",
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
      "name": "allowedMint",
      "docs": [
        "A token session keys may trade, with its Pyth USD price feed."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "mint",
            "type": "pubkey"
          },
          {
            "name": "feed",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "decimals",
            "type": "u8"
          },
          {
            "name": "bump",
            "type": "u8"
          },
          {
            "name": "reserved",
            "docs": [
              "Room for later settings without a migration."
            ],
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
      "name": "mintAllowed",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "mint",
            "type": "pubkey"
          },
          {
            "name": "allowed",
            "type": "bool"
          }
        ]
      }
    },
    {
      "name": "oracleSettings",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "maxAge",
            "docs": [
              "Oldest price a session-key swap may use, in seconds."
            ],
            "type": "u32"
          },
          {
            "name": "maxSlippageBps",
            "docs": [
              "How far below the oracle price a session-key swap may fill."
            ],
            "type": "u16"
          }
        ]
      }
    },
    {
      "name": "pausedSet",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "paused",
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
            "name": "pendingAdmin",
            "docs": [
              "Proposed by the admin; becomes the admin when it accepts."
            ],
            "type": "pubkey"
          },
          {
            "name": "paused",
            "docs": [
              "Stops session keys from trading. Never stops owners."
            ],
            "type": "bool"
          },
          {
            "name": "oracle",
            "type": {
              "defined": {
                "name": "oracleSettings"
              }
            }
          },
          {
            "name": "bump",
            "type": "u8"
          },
          {
            "name": "reserved",
            "docs": [
              "Room for later settings without a migration."
            ],
            "type": {
              "array": [
                "u8",
                64
              ]
            }
          }
        ]
      }
    },
    {
      "name": "priceFeedMessage",
      "repr": {
        "kind": "c"
      },
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "feedId",
            "docs": [
              "`FeedId` but avoid the type alias because of compatibility issues with Anchor's `idl-build` feature."
            ],
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "price",
            "type": "i64"
          },
          {
            "name": "conf",
            "type": "u64"
          },
          {
            "name": "exponent",
            "type": "i32"
          },
          {
            "name": "publishTime",
            "docs": [
              "The timestamp of this price update in seconds"
            ],
            "type": "i64"
          },
          {
            "name": "prevPublishTime",
            "docs": [
              "The timestamp of the previous price update. This field is intended to allow users to",
              "identify the single unique price update for any moment in time:",
              "for any time t, the unique update is the one such that prev_publish_time < t <= publish_time.",
              "",
              "Note that there may not be such an update while we are migrating to the new message-sending logic,",
              "as some price updates on pythnet may not be sent to other chains (because the message-sending",
              "logic may not have triggered). We can solve this problem by making the message-sending mandatory",
              "(which we can do once publishers have migrated over).",
              "",
              "Additionally, this field may be equal to publish_time if the message is sent on a slot where",
              "where the aggregation was unsuccesful. This problem will go away once all publishers have",
              "migrated over to a recent version of pyth-agent."
            ],
            "type": "i64"
          },
          {
            "name": "emaPrice",
            "type": "i64"
          },
          {
            "name": "emaConf",
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "priceUpdateV2",
      "docs": [
        "A price update account. This account is used by the Pyth Receiver program to store a verified price update from a Pyth price feed.",
        "It contains:",
        "- `write_authority`: The write authority for this account. This authority can close this account to reclaim rent or update the account to contain a different price update.",
        "- `verification_level`: The [`VerificationLevel`] of this price update. This represents how many Wormhole guardian signatures have been verified for this price update.",
        "- `price_message`: The actual price update.",
        "- `posted_slot`: The slot at which this price update was posted."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "writeAuthority",
            "type": "pubkey"
          },
          {
            "name": "verificationLevel",
            "type": {
              "defined": {
                "name": "verificationLevel"
              }
            }
          },
          {
            "name": "priceMessage",
            "type": {
              "defined": {
                "name": "priceFeedMessage"
              }
            }
          },
          {
            "name": "postedSlot",
            "type": "u64"
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
      "name": "swapped",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "agent",
            "type": "pubkey"
          },
          {
            "name": "inputMint",
            "type": "pubkey"
          },
          {
            "name": "outputMint",
            "type": "pubkey"
          },
          {
            "name": "amountIn",
            "type": "u64"
          },
          {
            "name": "amountOut",
            "type": "u64"
          },
          {
            "name": "byOwner",
            "type": "bool"
          }
        ]
      }
    },
    {
      "name": "verificationLevel",
      "docs": [
        "Pyth price updates are bridged to all blockchains via Wormhole.",
        "Using the price updates on another chain requires verifying the signatures of the Wormhole guardians.",
        "The usual process is to check the signatures for two thirds of the total number of guardians, but this can be cumbersome on Solana because of the transaction size limits,",
        "so we also allow for partial verification.",
        "",
        "This enum represents how much a price update has been verified:",
        "- If `Full`, we have verified the signatures for two thirds of the current guardians.",
        "- If `Partial`, only `num_signatures` guardian signatures have been checked.",
        "",
        "# Warning",
        "Using partially verified price updates is dangerous, as it lowers the threshold of guardians that need to collude to produce a malicious price update."
      ],
      "type": {
        "kind": "enum",
        "variants": [
          {
            "name": "partial",
            "fields": [
              {
                "name": "numSignatures",
                "type": "u8"
              }
            ]
          },
          {
            "name": "full"
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
