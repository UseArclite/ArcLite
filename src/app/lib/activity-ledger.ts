/**
 * Everything this vault has done, in one chronological list.
 *
 * The pieces already existed in three places that never met: deposits in the chain logs the
 * recovery scan reads, orders in the receipts endpoint, and this browser's own record of the
 * transactions it sent. A holder could see a balance, and could see what became of an individual
 * order, and could not see their own history.
 *
 * ## It is reconstructed, not retrieved
 *
 * There is no server-side account statement here and there cannot be one. `account_hash` is
 * salted per window precisely so a trader's orders cannot be linked across windows, which means
 * no query for "this person's activity" exists on our side — by design, and the design is the
 * product. What this does instead is merge sources the browser can already reach *because it
 * holds the keys*.
 *
 * The consequence is worth stating rather than hiding: a browser that lost its vault records sees
 * less here than one that kept them, and the recovery drill is what fixes that. A panel that
 * implied completeness would be claiming a lookup this venue deliberately cannot perform.
 */

export type ActivityKind = "deposit" | "order" | "fill" | "withdraw" | "approve";

export interface ActivityEntry {
  /** Epoch ms. Entries without a known time sort last rather than pretending to be old. */
  at: number | null;
  kind: ActivityKind;
  /** Registry asset id, where one applies. */
  assetId: string | null;
  /** Raw units, as a string. Never a number: these exceed what a float holds exactly. */
  units: string | null;
  /** Short status word for the row. */
  status: string;
  /** Transaction hash, where the action reached the chain. */
  hash: string | null;
  /** Window sequence, for anything that went through the auction. */
  windowSeq: number | null;
  /** A stable identity for React keys and for de-duplication across sources. */
  id: string;
}

export interface LedgerSources {
  /** From `/api/notes/deposits` — chain truth, with block timestamps. */
  deposits: { assetId: number; units: string; commitment: string; at: number | null }[];
  /** From `/api/orders/receipts` — what became of each order. */
  receipts: {
    commitment: string;
    windowSeq: number | null;
    orderStatus: string | null;
    settledAt: string | null;
    settledTx: string | null;
    fill: { reason: string; filledRaw: string; assetId: number; side: string } | null;
  }[];
  /** This browser's own record of what it sent. */
  transactions: {
    id: string;
    kind: "approve" | "deposit" | "withdraw";
    status: string;
    hash?: string;
    assetId?: string;
    units?: string;
    at: number;
  }[];
}

/**
 * Merge the three sources into one list, newest first.
 *
 * Deposits appear from both the chain and this browser's transaction log. The chain is preferred
 * — it has a block timestamp and a hash that is certainly real — and the local record is used
 * only for deposits the chain scan did not return, which is how a pending one shows up before it
 * confirms. Matching is by units and asset within a short window, because a local record carries
 * no commitment to match on.
 */
export function buildLedger(sources: LedgerSources): ActivityEntry[] {
  const entries: ActivityEntry[] = [];

  for (const d of sources.deposits) {
    entries.push({
      at: d.at,
      kind: "deposit",
      assetId: String(d.assetId),
      units: d.units,
      status: "confirmed",
      hash: null,
      windowSeq: null,
      id: `deposit:${d.commitment}`,
    });
  }

  for (const r of sources.receipts) {
    const settledAt = r.settledAt ? new Date(r.settledAt).getTime() : null;
    // The order itself. Its outcome is the fill below, when there is one.
    entries.push({
      at: settledAt,
      kind: "order",
      assetId: r.fill ? String(r.fill.assetId) : null,
      units: null,
      status: r.orderStatus ?? "submitted",
      hash: r.settledTx,
      windowSeq: r.windowSeq,
      id: `order:${r.commitment}`,
    });

    // A fill is a separate line because it is a separate fact: an order can exist and cross
    // nothing, and collapsing the two would hide the venue's most common outcome.
    if (r.fill && r.fill.filledRaw !== "0") {
      entries.push({
        at: settledAt,
        kind: "fill",
        assetId: String(r.fill.assetId),
        units: r.fill.filledRaw,
        status: r.fill.reason,
        hash: r.settledTx,
        windowSeq: r.windowSeq,
        id: `fill:${r.commitment}`,
      });
    }
  }

  // Deposits the chain already reported, so the local log does not double them up.
  const chainDeposits = sources.deposits.map((d) => ({
    assetId: String(d.assetId),
    units: d.units,
    at: d.at,
  }));

  for (const t of sources.transactions) {
    if (t.kind === "deposit") {
      const alreadyOnChain = chainDeposits.some(
        (d) =>
          d.assetId === (t.assetId ?? "") &&
          d.units === (t.units ?? "") &&
          // Within an hour: a deposit's block time and the moment this browser recorded sending
          // it differ by confirmation latency, not by hours.
          (d.at === null || Math.abs(d.at - t.at) < 3_600_000),
      );
      if (alreadyOnChain) continue;
    }
    entries.push({
      at: t.at,
      kind: t.kind,
      assetId: t.assetId ?? null,
      units: t.units ?? null,
      status: t.status,
      hash: t.hash ?? null,
      windowSeq: null,
      id: `tx:${t.id}`,
    });
  }

  // Newest first. Entries with no known time sort to the end rather than to 1970, which would
  // put them at the bottom anyway but for a reason that is a lie.
  return entries.sort((a, b) => {
    if (a.at === null && b.at === null) return 0;
    if (a.at === null) return 1;
    if (b.at === null) return -1;
    return b.at - a.at;
  });
}

/** CSV escaping: a quote doubles, and anything containing a separator or a newline is quoted. */
function csvCell(value: string): string {
  return /[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

/**
 * The ledger as a CSV.
 *
 * Raw units, not decimals: this is the file somebody hands an accountant, and a rounded figure in
 * a tax record is worse than an unfamiliar one. The ISO timestamp is UTC for the same reason.
 */
export function ledgerCsv(entries: ActivityEntry[]): string {
  const header = ["time_utc", "action", "asset_id", "raw_units", "status", "window", "tx_hash"];
  const rows = entries.map((e) =>
    [
      e.at === null ? "" : new Date(e.at).toISOString(),
      e.kind,
      e.assetId ?? "",
      e.units ?? "",
      e.status,
      e.windowSeq === null ? "" : String(e.windowSeq),
      e.hash ?? "",
    ]
      .map(csvCell)
      .join(","),
  );
  return [header.join(","), ...rows].join("\n");
}
