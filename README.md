<div align="center">

<img src=".github/assets/arclite.jpg" alt="ArcLite" width="180" />

# ArcLite

**A private batch-auction venue for tokenized real-world assets.**

Sealed orders. Reference prices committed on chain. Public proofs.

[![Website](https://img.shields.io/badge/Website-arclite.tech-000080?style=flat-square)](https://arclite.tech)
[![Documentation](https://img.shields.io/badge/Docs-arclite.tech%2Fdocs-0058aa?style=flat-square)](https://arclite.tech/docs)
[![X](https://img.shields.io/badge/X-@UseArclite-000000?style=flat-square&logo=x)](https://x.com/UseArclite)
[![Telegram](https://img.shields.io/badge/Telegram-arcliteonrobinhood-229ED9?style=flat-square&logo=telegram)](https://t.me/arcliteonrobinhood)

[![Network](https://img.shields.io/badge/Robinhood%20Chain-4663-e8bfd6?style=flat-square)](https://robinhoodchain.blockscout.com)
[![Proofs](https://img.shields.io/badge/Proofs-Noir%20%C2%B7%20UltraHonk-00b9e4?style=flat-square)](https://noir-lang.org)
[![Audit](https://img.shields.io/badge/Audit-none-c82750?style=flat-square)](#security)

</div>

---

> [!WARNING]
> **The contracts in this repository are unaudited.** They are deployed on Robinhood Chain mainnet
> and handle real assets. Nothing here is an offer, a solicitation, or investment advice. Access is
> subject to screening and jurisdiction eligibility. Read [Security](#security) before depositing.

---

## Overview

ArcLite is a **uniform-price batch auction** for tokenized equities and ETFs, running on
[Robinhood Chain](https://robinhoodchain.blockscout.com) — an Arbitrum Orbit L2. It is not an
order book and not an automated market maker.

Orders arrive encrypted and accumulate for the length of a window. When the window closes the book
is frozen, and only *then* does the contract read its price oracles and commit a reference table on
chain. Everything crosses at that reference, pro-rata, and the whole batch settles under a single
zero-knowledge proof.

That ordering — **seal the book, then fix the prices** — is the venue's central security property.
Nobody, the operator included, can see a book and then choose the prices it will trade against.

Balances are held as shielded notes in an append-only commitment tree. A browser derives its own
keys from a wallet signature, locates its own notes, and proves its own withdrawals locally. No
server is ever told which leaves belong to whom.

## How a trade works

| Stage | What happens | Who can see the order |
|:--|:--|:--|
| **1 · Submit** | The order is built and encrypted inside a Web Worker. A commitment, two hashes and a ciphertext leave the browser. | Nobody |
| **2 · Seal** | The window closes. `sealWindow` freezes the orders root on chain. | Nobody |
| **3 · Price** | `PriceCommitter` reads Chainlink and each issuer's multiplier *in Solidity*, and commits a price table plus a defer mask. | — |
| **4 · Cross** | Matched size is the smaller side in full, allocated by largest-remainder pro-rata. No fill rate is chosen by anyone. | The operator, for this window only |
| **5 · Settle** | One `batch_cross` proof per sub-batch. Nullifiers are published, output notes are spliced into the tree. | Nobody, per order |

Nullifiers are published **only at settlement**, so a window that fails to prove strands nothing:
the notes were never spent and the orders are released.

## Architecture

```
Browser ───────────────────────────────────────────►  Robinhood Chain (4663)
  wallet · viem/wagmi                                   EligibleRegistry ──► PriceCommitter
  keys, note discovery and unshield proving               │                    ▲ EventCalendar
  inside a Web Worker — secrets never reach              RwaDarkPool ──► BatchCrossVerifier
  the document scope                                      └─► CommitmentTree (Poseidon2, depth 24)
      │                            ▲
      │ TanStack Query             │ settlement
      ▼                            │
Vercel Functions ──────────────────┘
  order intake · window FSM · matcher · prover · settler
      ▼
PostgreSQL
  windows · orders · fills · price observations · guards
```

### Components

| Layer | Technology | Responsibility |
|:--|:--|:--|
| Contracts | Solidity 0.8.28, Foundry | Custody, price commitment, nullifier uniqueness, solvency invariant |
| Circuits | [Noir](https://noir-lang.org) 1.0.0-rc.2, Barretenberg UltraHonk | `batch_cross`, `unshield`, `screening`, `tree` |
| Hashing | Poseidon2 over BN254 | Identical implementations in Solidity and Noir, differentially fuzzed |
| Signatures | Grumpkin Schnorr | One signature per user bundle, verified inside the circuit |
| Application | React 19, TanStack Start, Vite 8, Bun | Dashboard, vault, order intake |
| Chain access | viem 2, wagmi 3 | Reads and wallet interaction |
| Off-chain tier | Vercel Functions + Cron, PostgreSQL | Window lifecycle, matching, proving, settlement |

## Deployed contracts — Robinhood Chain mainnet (4663)

| Contract | Address |
|:--|:--|
| `RwaDarkPool` | [`0xE14B341d854354C767abdb634fC7B85652018222`](https://robinhoodchain.blockscout.com/address/0xE14B341d854354C767abdb634fC7B85652018222) |
| `PriceCommitter` | [`0xcB0165Ac908B4758C2790BC2DeB59ECa20b432F6`](https://robinhoodchain.blockscout.com/address/0xcB0165Ac908B4758C2790BC2DeB59ECa20b432F6) |
| `EligibleRegistry` | [`0x9c4004d59f97b7993D621D867262f91745C594C7`](https://robinhoodchain.blockscout.com/address/0x9c4004d59f97b7993D621D867262f91745C594C7) |
| `EventCalendar` | [`0x336F7b0A26845Fb7Cd479A3e0C14A90Fa309AE5F`](https://robinhoodchain.blockscout.com/address/0x336F7b0A26845Fb7Cd479A3e0C14A90Fa309AE5F) |
| `BatchCrossVerifier` | [`0x54c62F552449FD7031ddA89B978eC2925C411D01`](https://robinhoodchain.blockscout.com/address/0x54c62F552449FD7031ddA89B978eC2925C411D01) |
| `UnshieldVerifier` | [`0x1870F3D4a7D91B4dC3d735939dbec9538096Dc77`](https://robinhoodchain.blockscout.com/address/0x1870F3D4a7D91B4dC3d735939dbec9538096Dc77) |

`RwaDarkPool` is **immutable**: no proxy, no `delegatecall`, no `selfdestruct`. A fix is a new
deployment, and notes in a retired pool remain withdrawable from it indefinitely.

**Eligible universe:** 35 tokenized equities and ETFs — every Robinhood tokenized asset that has a
Chainlink price feed — quoted in USDG. An asset is admitted only if it is both registered *and*
priceable; a venue that cannot derive a guarded reference for an asset has no business crossing it.

## Repository layout

```
contracts/        Foundry project — pool, registry, price committer, verifiers
circuits/         Noir workspace — batch_cross, unshield, screening, tree
src/
  app/            Dashboard, vault UI, market panels
  lib/notes/      Note derivation, Poseidon2, Grumpkin, proving
  lib/chain/      Chain clients, registry, market snapshot, sessions
  server/         Window FSM, matcher, prover, settler, relayer
  routes/api/     Market, orders, proofs and cron endpoints
  workers/        Vault worker — the only place key material exists
supabase/         SQL migrations
scripts/          End-to-end probes and operational tooling
```

## Getting started

### Prerequisites

| Tool | Version |
|:--|:--|
| [Bun](https://bun.sh) | 1.3+ |
| [Foundry](https://getfoundry.sh) | for contracts |
| [Noir](https://noir-lang.org) (`nargo`) + Barretenberg (`bb`) | for circuits |
| PostgreSQL | 15+, or a Supabase project |

### Install and run

```bash
bun install
cp .env.example .env.local     # fill in chain, database and secrets
bun run dev
```

The dashboard is served at `http://localhost:3000`. Market data, guards and the window clock are
public and render without a wallet; balances and order submission require one.

### Configuration

All configuration is environment-driven. `.env.example` documents every variable. The essentials:

| Variable | Purpose |
|:--|:--|
| `ARCLITE_CHAIN_ID` | `4663` mainnet, `46630` testnet |
| `VITE_ARCLITE_CHAIN_ID` | The same value, for the browser bundle |
| `DATABASE_URL` | PostgreSQL connection string |
| `ARCLITE_WINDOW_SECONDS` | Auction window length — default `300` |
| `CRON_SECRET` | Authenticates scheduled invocations |

## Testing

```bash
bun test                  # unit and integration suites
bun run test:contracts    # forge test
bun run test:migrations   # migration validation
bun run lint              # eslint + prettier
```

The application suite is **269 tests**. Coverage is concentrated where a silent failure would cost
money: note derivation, the matcher's conservation and determinism properties, order affordability,
and the spent-note check.

## Security

### Threat model, stated honestly

Zero-knowledge proofs do not hide an order from the matcher. They change who *else* can see it and
what can be proved afterwards.

| Party | What they can see |
|:--|:--|
| Public chain | Commitment hashes, nullifiers, Merkle roots, delayed aggregate volume — nothing per-order |
| Venue operator | One window's book in plaintext, after that window has sealed |
| Other traders | Nothing |
| Auditor holding a scoped grant | Decryption of exactly the epochs their grant names |

Further limits worth knowing before depositing:

- **Deposits are public transfers.** The link between a funding address and a shielded position is
  not broken by this design; privacy comes from the size of the anonymity set, which is small at
  launch. The dashboard reports that set size rather than implying more than is true.
- **Withdrawal needs no operator.** `unshield` carries no pause, no role and no window check. A
  holder who can produce a valid proof can exit whatever the venue is doing — and the proof is
  generated in their own browser, because a server that could prove a withdrawal could also spend
  the note.
- **Solvency is a check, not a proof.** Crossing transfers zero ERC-20s, so the pool's obligations
  change only on deposit and withdrawal. Solvency reduces to
  `balanceOf(pool) >= totalUnits(asset)` — something anyone can evaluate against the chain without
  trusting an operator, a prover or a verifier.
- **Reference prices carry a bounded deviation.** Chainlink updates on a 0.5 % move or a heartbeat,
  so a committed reference may sit up to that far from the true mid. This is a disclosed property
  of the venue, not a defect.

### Reporting a vulnerability

Please report security issues privately through [X](https://x.com/UseArclite) or
[Telegram](https://t.me/arcliteonrobinhood) rather than opening a public issue.

## Links

| | |
|:--|:--|
| Website | [arclite.tech](https://arclite.tech) |
| Documentation | [arclite.tech/docs](https://arclite.tech/docs) |
| Dashboard | [arclite.tech/dashboard](https://arclite.tech/dashboard) |
| X | [@UseArclite](https://x.com/UseArclite) |
| Telegram | [arcliteonrobinhood](https://t.me/arcliteonrobinhood) |
| Explorer | [robinhoodchain.blockscout.com](https://robinhoodchain.blockscout.com) |

---

<div align="center">

<sub>
<b>ArcLite</b> — private execution, real-world value.<br/>
Protocol in development. Access is subject to asset availability, screening and jurisdiction
eligibility. The contracts are unaudited and nothing here is investment advice.
</sub>

</div>
