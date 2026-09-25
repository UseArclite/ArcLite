import { describe, expect, test } from "bun:test";
import { buildLedger, ledgerCsv, type LedgerSources } from "../activity-ledger";

/**
 * Two things this must not do.
 *
 * It must not show a deposit twice — it arrives from the chain scan and from this browser's own
 * transaction log, and a ledger that double-counts deposits is a ledger nobody can reconcile
 * against their own wallet.
 *
 * And it must not merge an order with its fill. An order that crossed nothing is the most common
 * outcome on this venue; collapsing the two lines would hide exactly that.
 */

const NOW = 1_700_000_000_000;

const sources = (over: Partial<LedgerSources> = {}): LedgerSources => ({
  deposits: [],
  receipts: [],
  transactions: [],
  ...over,
});

describe("deposits", () => {
  const chainDeposit = { assetId: 22, units: "1000000", commitment: "0xaaa", at: NOW };
  const localDeposit = {
    id: "t1",
    kind: "deposit" as const,
    status: "confirmed",
    hash: "0xdead",
    assetId: "22",
    units: "1000000",
    at: NOW + 20_000,
  };

  test("a deposit seen by both sources appears once, from the chain", () => {
    const l = buildLedger(sources({ deposits: [chainDeposit], transactions: [localDeposit] }));
    expect(l.filter((e) => e.kind === "deposit")).toHaveLength(1);
    expect(l[0]!.id).toBe("deposit:0xaaa");
  });

  test("a pending deposit the chain has not reported yet still shows", () => {
    const l = buildLedger(sources({ transactions: [{ ...localDeposit, status: "pending" }] }));
    expect(l).toHaveLength(1);
    expect(l[0]!.status).toBe("pending");
  });

  test("a second deposit of the same size months later is not swallowed", () => {
    // The de-duplication matches on asset and units, so it must also bound by time or a repeat
    // purchase of the same amount would vanish from the holder's own history.
    const later = { ...localDeposit, id: "t2", at: NOW + 90 * 86_400_000 };
    const l = buildLedger(sources({ deposits: [chainDeposit], transactions: [later] }));
    expect(l.filter((e) => e.kind === "deposit")).toHaveLength(2);
  });
});

describe("orders and fills", () => {
  const receipt = {
    commitment: "0xbbb",
    windowSeq: 500,
    orderStatus: "settled",
    settledAt: new Date(NOW).toISOString(),
    settledTx: "0xfeed",
    fill: { reason: "matched", filledRaw: "500000", assetId: 22, side: "buy" },
  };

  test("an order and its fill are separate lines", () => {
    const l = buildLedger(sources({ receipts: [receipt] }));
    expect(l.map((e) => e.kind).sort()).toEqual(["fill", "order"]);
  });

  test("an order that crossed nothing produces no fill line", () => {
    // The venue's most common outcome. A single merged row would imply something happened.
    const unmatched = {
      ...receipt,
      fill: { reason: "unmatched", filledRaw: "0", assetId: 22, side: "buy" },
    };
    const l = buildLedger(sources({ receipts: [unmatched] }));
    expect(l.filter((e) => e.kind === "fill")).toHaveLength(0);
    expect(l.filter((e) => e.kind === "order")).toHaveLength(1);
  });

  test("both carry the window and the settlement hash", () => {
    const l = buildLedger(sources({ receipts: [receipt] }));
    for (const e of l) {
      expect(e.windowSeq).toBe(500);
      expect(e.hash).toBe("0xfeed");
    }
  });
});

describe("ordering", () => {
  test("newest first, and unknown times sort last", () => {
    const l = buildLedger(
      sources({
        deposits: [
          { assetId: 1, units: "1", commitment: "0x1", at: NOW - 1000 },
          { assetId: 1, units: "2", commitment: "0x2", at: null },
          { assetId: 1, units: "3", commitment: "0x3", at: NOW },
        ],
      }),
    );
    expect(l.map((e) => e.id)).toEqual(["deposit:0x3", "deposit:0x1", "deposit:0x2"]);
  });
});

describe("the export", () => {
  test("carries raw units, never a rounded figure", () => {
    // This is the file somebody hands an accountant. An 18-decimal amount rounded through a
    // float would be wrong in a record that is supposed to be exact.
    const csv = ledgerCsv(
      buildLedger(
        sources({
          deposits: [{ assetId: 22, units: "12480000000000000000", commitment: "0xa", at: NOW }],
        }),
      ),
    );
    expect(csv).toContain("12480000000000000000");
    expect(csv.split("\n")[0]).toBe("time_utc,action,asset_id,raw_units,status,window,tx_hash");
  });

  test("escapes a value containing a comma or a quote", () => {
    const csv = ledgerCsv([
      {
        at: NOW,
        kind: "order",
        assetId: "1",
        units: null,
        status: 'we, "said"',
        hash: null,
        windowSeq: null,
        id: "x",
      },
    ]);
    expect(csv).toContain('"we, ""said"""');
  });

  test("an empty ledger is a header, not an empty file", () => {
    expect(ledgerCsv([]).split("\n")).toHaveLength(1);
  });
});
