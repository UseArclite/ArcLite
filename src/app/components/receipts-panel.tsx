"use client";
import { useQuery } from "@tanstack/react-query";
import { useVault } from "./vault-provider";
import { useMarket } from "./market-provider";
import { CHAINS, clientChainId } from "@/lib/chain/chains";
import { useT } from "../lib/i18n";

/**
 * What happened to the orders you submitted.
 *
 * The dashboard could show a balance and a solvency check but never an outcome: a settled order
 * existed on chain and in the venue's database, and the only way to read it was to ask someone
 * with a database client. A trader could see that their money had moved without ever being told
 * why.
 *
 * It asks by note commitment, because an order is submitted under one — and the vault already
 * knows every commitment it owns, since it needs them to find the notes at all. So there is no
 * separate record of "orders I placed": one source of truth, and anything that recovers the
 * notes recovers their history with them.
 *
 * That it must be asked this way is the privacy model, not a limitation of the UI.
 * `account_hash` is salted with each window's own public key, so it links a trader's orders
 * within a window and deliberately cannot link them across windows. There is no server-side
 * query for "this person's orders" — only the holder of the keys can name which commitments to
 * ask about, and the venue saw every one of them at submission, so asking reveals nothing it did
 * not already hold.
 */

interface Receipt {
  commitment: string;
  windowSeq: number | null;
  windowStatus: string | null;
  orderStatus: string | null;
  settledAt: string | null;
  settledTx: string | null;
  fill: {
    reason: string;
    filledRaw: string;
    residualRaw: string;
    quoteRaw: string;
    assetId: number;
    side: string;
    quantityRaw: string;
  } | null;
}

/** Raw units to a readable quantity, at whatever scale the token uses. */
function amount(raw: string, decimals: number): string {
  const n = Number(BigInt(raw)) / 10 ** decimals;
  return n.toLocaleString("en-US", { maximumFractionDigits: 6 });
}

/**
 * What the venue did, in words.
 *
 * `unmatched` is the one worth spelling out. It is the expected result on a venue with few
 * participants and reads like a failure if left as one word — nothing crossed because nobody was
 * on the other side, and the order's own quantity came back untouched.
 */
const REASONS: Record<string, string> = {
  matched: "Filled in full",
  partial: "Partly filled — the rest came back",
  unmatched: "No counterparty this window — nothing crossed, your note is unchanged",
  stale: "Deferred — the reference was too old to cross against",
  event: "Deferred — a corporate action was in progress",
};

export function ReceiptsPanel() {
  const t = useT();
  const vault = useVault();
  const market = useMarket();
  // Every commitment this vault owns, newest first. An order is submitted under its note's
  // commitment, so these are exactly the handles to ask about — and they come from the same
  // records the vault already needs to find the notes at all, rather than a second list kept
  // alongside that could disagree with it.
  const orders = [...vault.notes, ...vault.legacyNotes]
    .map((n) => n.commitment)
    .filter((c, i, all) => all.indexOf(c) === i)
    .reverse();
  const explorer = CHAINS[clientChainId()].blockExplorers.default.url;

  const { data, isPending } = useQuery({
    queryKey: ["order-receipts", orders.join(",")],
    enabled: orders.length > 0,
    queryFn: async (): Promise<Receipt[]> => {
      const res = await fetch("/api/orders/receipts", {
        method: "POST",
        // No cookie, for the same reason submission sends none: a session here would put the
        // address-to-order link in our own logs.
        credentials: "omit",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ commitments: orders }),
      });
      const body = (await res.json()) as { receipts?: Receipt[] };
      return body.receipts ?? [];
    },
    // A window takes five minutes and settlement about one, so this is the resolution that
    // matters. Polling harder would just be louder.
    refetchInterval: 20_000,
    staleTime: 10_000,
  });

  if (vault.status !== "unlocked") {
    return (
      <div className="receipt">
        <span>{t("YOUR ORDERS")}</span>
        <p className="ticket-note">{t("Open your vault to see what became of your orders.")}</p>
      </div>
    );
  }

  if (orders.length === 0) {
    return (
      <div className="receipt">
        <span>{t("YOUR ORDERS")}</span>
        <p className="ticket-note">
          {t(
            "No orders from this browser yet. Submit a sealed order and its outcome appears here once the window settles.",
          )}
        </p>
      </div>
    );
  }

  // Only commitments the venue has actually seen. The vault owns a commitment for every note,
  // including ones never traded, and listing those as orders would be inventing history.
  const placed = (data ?? []).filter((r) => r.windowSeq !== null);

  if (!isPending && placed.length === 0) {
    return (
      <div className="receipt">
        <span>{t("YOUR ORDERS")}</span>
        <p className="ticket-note">
          {t(
            "No orders yet. Submit a sealed order and its outcome appears here once the window settles.",
          )}
        </p>
      </div>
    );
  }

  return (
    <div className="receipt">
      <span>{t("YOUR ORDERS")}</span>
      {isPending && !data && <p className="ticket-note">{t("Reading the venue…")}</p>}
      {placed.map((r) => {
        // Asset, side and quantity come back with the fill — the venue revealed them at seal, so
        // there is nothing here the client has to have remembered.
        const assetId = r.fill?.assetId;
        const asset = vault.poolAssets.find((a) => a.assetId === assetId);
        const symbol = asset?.symbol ?? (assetId ? `asset ${assetId}` : "order");
        const decimals = asset?.decimals ?? 18;
        const quote = vault.poolAssets.find((a) => a.isQuote);

        // Three states, and the middle one is most of a window's life.
        const status = r.fill
          ? (REASONS[r.fill.reason] ?? r.fill.reason)
          : r.windowStatus === "FAILED" || r.windowStatus === "VOID"
            ? "The window failed — nothing crossed and your note was never spent"
            : "Sealed — waiting for the window to close";

        return (
          <article key={r.commitment} className="receipt-row">
            <p>
              <b>
                {r.fill
                  ? `${r.fill.side === "buy" ? "Buy" : "Sell"} ${amount(r.fill.quantityRaw, decimals)} ${symbol}`
                  : "Sealed order"}
              </b>
              {r.windowSeq ? ` · window ${r.windowSeq}` : ""}
            </p>
            <p>{status}</p>
            {r.fill && r.fill.reason !== "unmatched" && (
              <p>
                Filled {amount(r.fill.filledRaw, decimals)} {symbol}
                {r.fill.quoteRaw !== "0" && quote
                  ? ` for ${amount(r.fill.quoteRaw, quote.decimals)} ${quote.symbol}`
                  : ""}
                {r.fill.residualRaw !== "0"
                  ? ` · ${amount(r.fill.residualRaw, decimals)} ${symbol} returned`
                  : ""}
              </p>
            )}
            {r.settledTx && (
              <p>
                <a href={`${explorer}/tx/${r.settledTx}`} target="_blank" rel="noreferrer">
                  {t("Settled on chain ↗")}
                </a>
              </p>
            )}
          </article>
        );
      })}
      <p className="ticket-note">
        Found by asking the venue about the notes your vault holds. Orders are unlinkable across
        windows by design, so nothing can assemble this list without your keys — and anything that
        recovers your notes recovers this with them.
        {market.network === "mainnet" ? "" : " Testnet."}
      </p>
    </div>
  );
}
