"use client";
import { useEffect, useState } from "react";
import {
  ArrowDownToLine,
  ArrowUpFromLine,
  KeyRound,
  Loader2,
  LockKeyhole,
  ShieldAlert,
  ShieldCheck,
  Unlock,
} from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { useAccount, useWriteContract } from "wagmi";
import { erc20Abi, useVault, type VaultNote } from "./vault-provider";
import { Holdings } from "./holdings";
import { TransactionTrail } from "./transaction-trail";
import { VaultLock } from "./vault-lock";
import { feature } from "../lib/features";
import { AmountField } from "./amount-field";
import { displayAmount, formatAmount, parseAmount } from "../lib/units";
import { assessWithdrawal } from "../lib/withdraw-privacy";
import { useT } from "../lib/i18n";

/**
 * The shielded vault on the Portfolio tab.
 *
 * The holdings table beside this one is simulated and says so. This panel is the real thing:
 * keys derived in a worker from a signature, notes located in the on-chain commitment set, and
 * a balance in raw units that no server computed. Today it finds nothing, because the pool is
 * not deployed — and it says exactly that rather than rendering an empty table that reads as a
 * loading state or, worse, as a real zero.
 */
export function VaultPanel() {
  const t = useT();
  const { isConnected } = useAccount();
  const vault = useVault();

  return (
    <section className="vault-panel">
      <div className="panel-top">
        <div>
          <span className="eyebrow">{t("SHIELDED VAULT · LIVE")}</span>
          <h2>{t("Your private balance")}</h2>
        </div>
        {vault.status === "unlocked" ? <Unlock size={19} /> : <LockKeyhole size={19} />}
      </div>

      {vault.status !== "unlocked" ? (
        <>
          <p className="vault-copy">
            {t(
              "Your shielded balance is computed in your browser, from keys derived from a signature. Nothing here is sent to a server: the vault reads the public commitment set and works out which notes are yours locally, so no one — us included — learns which leaves you asked about.",
            )}
          </p>
          <button
            className="seal-order-button"
            onClick={() => void vault.unlock()}
            disabled={!isConnected || vault.status === "unlocking"}
          >
            <KeyRound size={16} />
            {vault.status === "unlocking"
              ? "Check MetaMask…"
              : isConnected
                ? "Open private vault"
                : "Connect MetaMask to open"}
          </button>
          <p className="ticket-note">
            {t("Signing derives your viewing keys. It approves no transaction and moves no funds.")}
          </p>
        </>
      ) : (
        <>
          <div className="vault-stats">
            <div>
              <span>{t("Vault")}</span>
              <strong
                title={t(
                  "A hash of your viewing key — it identifies the vault without being able to read it.",
                )}
              >
                {vault.fingerprint}
              </strong>
            </div>
            <div>
              <span>{t("Your notes")}</span>
              <strong>
                {vault.scanning ? <Loader2 size={15} className="spin" /> : vault.noteCount}
              </strong>
            </div>
            <div>
              <span>{t("Anonymity set")}</span>
              <strong>{vault.leafCount.toLocaleString("en-US")}</strong>
            </div>
          </div>

          {/* An empty vault and an unreadable one look identical, and only one of them is good
              news. Said before the balances rather than after, because it changes what the
              numbers below mean. */}
          {vault.spentUnknown && (
            <div className="guard-result deferred" role="status">
              <ShieldCheck size={16} />
              <span>
                {t(
                  "Robinhood Chain could not be reached to check which notes are already spent, so none are shown. Your notes are safe and nothing has been lost — this retries on its own every few seconds.",
                )}
              </span>
            </div>
          )}

          {feature("positions") && vault.balances.length > 0 ? (
            <Holdings />
          ) : vault.balances.length > 0 ? (
            <ul className="vault-balances">
              {vault.balances.map((b) => (
                <li key={b.assetId}>
                  <span>Asset {b.assetId}</span>
                  <b>{b.units}</b>
                  {/* Raw units, and the leaf each note sits at — the position its nullifier and
                      its spend signature are both bound to. */}
                  <small>
                    raw units ·{" "}
                    {vault.notes
                      .filter((n) => n.assetId === b.assetId && !n.spent)
                      .map((n) => `leaf ${n.leafIndex}`)
                      .join(", ")}
                  </small>
                </li>
              ))}
            </ul>
          ) : (
            <div className="guard-result" role="status">
              <ShieldCheck size={16} />
              <span>
                {vault.deployed
                  ? "No shielded notes found for this vault. Shield a deposit to create your first note."
                  : "The pool is not deployed on this network yet, so there are no notes to find. Your keys are derived and the scan runs end to end — it returns nothing because nothing exists yet."}
              </span>
            </div>
          )}

          <Deposit />
          <Withdraw />

          {feature("tx-receipts") && <TransactionTrail />}

          <Recover />

          {feature("vault-lock") ? (
            <VaultLock />
          ) : (
            <button className="reset-demo" onClick={vault.lock}>
              <LockKeyhole size={14} /> {t("Lock vault")}
            </button>
          )}
        </>
      )}

      {vault.error && (
        <p role="alert" className="ticket-error">
          {vault.error}
        </p>
      )}
    </section>
  );
}

/**
 * What this withdrawal would tell anyone reading the chain.
 *
 * The privacy meter already says timing correlation is the weak link at small set sizes. It says
 * it on the same tab, in the abstract, to somebody who is not currently withdrawing — and the
 * moment the warning could change a decision is this one, with an amount typed and a button
 * about to be pressed.
 *
 * The deposit times come from the chain rather than from this browser's records: block
 * timestamps are what an observer would use, a recovered vault has no local record of when
 * anything landed, and `/api/notes/deposits` already reads exactly these logs for recovery.
 * Reading it here adds no linkage that was not already public — `shield` is a plain transfer
 * from a known address, which is the whole reason this warning has anything to warn about.
 *
 * Nothing here blocks the button. `unshield` is the path that must always work; the point is
 * that a holder taking a linkability hit should be taking it knowingly.
 */
function Linkability({ units, address }: { units: string; address?: `0x${string}` }) {
  const vault = useVault();

  const { data, isPending } = useQuery({
    queryKey: ["deposit-times", address],
    enabled: Boolean(address),
    staleTime: 5 * 60_000,
    queryFn: async () => {
      // `credentials: 'omit'` for the same reason the order route uses it: nothing about this
      // request needs a session, so it should not carry one.
      const response = await fetch(`/api/notes/deposits?address=${address}`, {
        credentials: "omit",
      });
      const body = (await response.json()) as {
        deposits?: { at: number | null; units: string }[];
      };
      return body.deposits ?? [];
    },
  });

  // Nothing typed is nothing to assess, and a spinner here would be noise in a form.
  if (!units || isPending) return null;

  const deposits = data ?? [];
  const note = assessWithdrawal({
    depositTimes: deposits.map((d) => d.at).filter((at): at is number => typeof at === "number"),
    depositUnits: deposits.map((d) => d.units),
    units,
    // The same figure the privacy meter shows, for the same reason: your own notes hide you from
    // nobody, so a pool you are most of is not a crowd.
    othersInPool: Math.max(0, vault.commitmentCount - vault.notes.length),
  });

  return (
    <div className={"guard-result" + (note.level === "high" ? " deferred" : "")} role="note">
      {note.level === "high" ? <ShieldAlert size={16} /> : <ShieldCheck size={16} />}
      <span>
        {note.headline}
        {note.advice ? ` ${note.advice}` : ""}
      </span>
    </div>
  );
}

/**
 * Withdrawing, proved in this browser.
 *
 * The proof takes a few seconds and happens in the vault worker, where the secrets already are.
 * That is the point rather than an implementation detail: `RwaDarkPool.unshield` has no pause,
 * no role and no window check, so a holder who can produce this proof can leave whatever the
 * venue is doing — and a server that could prove it for them could also spend their note.
 *
 * Notes stranded in a retired pool appear here too. `RwaDarkPool` is immutable, so every fix is
 * a new address; the old pool still honours withdrawals, but nothing would show those notes
 * again unless the vault deliberately looked. A balance that silently vanished is the worst
 * version of that.
 */
function Withdraw() {
  const t = useT();
  const vault = useVault();
  const { address } = useAccount();
  // Spent notes are not withdrawable, and the tree gives no hint of it — a commitment stays in
  // it forever, so a note consumed by a settlement scans exactly like a live one. Offering it
  // produced a transaction that reverted with `NullifierAlreadySpent` and cost the holder gas
  // to learn what the pool could simply have been asked.
  const withdrawable: { note: VaultNote; pool?: `0x${string}`; label: string }[] = [
    ...vault.notes.filter((n) => !n.spent).map((n) => ({ note: n, pool: undefined, label: "" })),
    ...vault.legacyNotes
      .filter((n) => !n.spent)
      .map((n) => ({
        note: n,
        pool: n.pool,
        label: ` · retired pool ${n.pool.slice(0, 8)}…`,
      })),
  ];

  const [selected, setSelected] = useState(0);
  const [units, setUnits] = useState("");
  const [typed, setTyped] = useState("");
  const [message, setMessage] = useState<{ text: string; ok: boolean } | null>(null);

  const chosen = withdrawable[selected];
  const chosenAsset = vault.poolAssets.find((a) => String(a.assetId) === chosen?.note.assetId);
  const chosenDecimals = chosenAsset?.decimals ?? 18;
  // Default the decimal field to the whole note, matching what `amount` already falls back to.
  useEffect(() => {
    if (chosen && typed === "") setTyped(formatAmount(BigInt(chosen.note.units), chosenDecimals));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chosen?.note.commitment]);
  // Default to the whole note: a full withdrawal publishes no change note, which is both the
  // cheapest and the least surprising outcome.
  const amount = units || chosen?.note.units || "";

  async function send() {
    if (!chosen || !address) return;
    setMessage({ text: "Proving in your browser — this takes a few seconds…", ok: true });
    const result = await vault.withdraw({
      note: chosen.note,
      units: amount,
      recipient: address,
      pool: chosen.pool,
    });
    setMessage({
      text: result.ok
        ? `Withdrawn. Proved in ${((result.provingMs ?? 0) / 1000).toFixed(1)}s, settled on chain.`
        : (result.reason ?? "The withdrawal failed."),
      ok: result.ok,
    });
    if (result.ok) setUnits("");
  }

  if (withdrawable.length === 0) return null;

  return (
    <div className="vault-deposit">
      <span className="eyebrow">{t("WITHDRAW")}</span>
      <div className="sealed-order-fields">
        <label>
          <span>{t("Note")}</span>
          <select value={selected} onChange={(e) => setSelected(Number(e.target.value))}>
            {withdrawable.map((w, i) => (
              <option key={`${w.pool ?? "current"}-${w.note.leafIndex}`} value={i}>
                {feature("human-units")
                  ? `${vault.poolAssets.find((a) => String(a.assetId) === w.note.assetId)?.symbol ?? `asset ${w.note.assetId}`} · ${displayAmount(BigInt(w.note.units), vault.poolAssets.find((a) => String(a.assetId) === w.note.assetId)?.decimals ?? 18)}`
                  : `asset ${w.note.assetId} · ${w.note.units} units`}{" "}
                · leaf {w.note.leafIndex}
                {w.label}
              </option>
            ))}
          </select>
        </label>
        {feature("human-units") ? (
          <AmountField
            label={t("Amount")}
            symbol={chosenAsset?.symbol}
            decimals={chosenDecimals}
            value={typed}
            // The whole note. Exact, because a note is spent whole and a rounded MAX would leave
            // a remainder too small to be worth a second withdrawal.
            max={chosen ? BigInt(chosen.note.units) : undefined}
            onChange={(text, raw) => {
              setTyped(text);
              setUnits(raw !== undefined ? raw.toString() : "");
            }}
          />
        ) : (
          <label>
            <span>{t("Raw units")}</span>
            <input
              value={amount}
              inputMode="numeric"
              onChange={(e) => setUnits(e.target.value.replace(/\D/g, ""))}
            />
          </label>
        )}
      </div>
      {feature("withdraw-timing") && <Linkability units={amount} address={address} />}
      <div className="vault-deposit-actions">
        <button
          className="seal-order-button"
          onClick={() => void send()}
          disabled={vault.withdrawing || !amount || !address}
        >
          <ArrowUpFromLine size={16} />
          {vault.withdrawing ? "Proving…" : "Withdraw to my wallet"}
        </button>
      </div>
      <p className="ticket-note">
        The proof is generated here, in your browser, from keys that never leave it. Withdrawal
        needs no operator: the pool accepts a valid proof from anyone, with no pause, no role and no
        window check.
        {vault.legacyNotes.length > 0 &&
          " Notes marked as a retired pool predate a redeploy — still yours, still withdrawable, but not tradable."}
      </p>
      {message && (
        <p role="status" className={message.ok ? "ticket-note" : "ticket-error"}>
          {message.text}
        </p>
      )}
    </div>
  );
}

/** One whole token in raw units, from the asset's own decimals. */
const wholeUnit = (decimals: number) => (10n ** BigInt(decimals)).toString();

/**
 * Minting test tokens and shielding them.
 *
 * Both are testnet-only affordances and say so. The faucet exists because `TestnetStockToken`
 * has an open `mint` — there is no real issuer to ask — and it refuses to deploy on mainnet, so
 * this control cannot follow it there.
 *
 * Depositing is two transactions the trader signs: an approval, then `shield`. What reaches the
 * chain is a commitment, so the pool learns the amount and the asset and nothing else.
 */
function Deposit() {
  const t = useT();
  const vault = useVault();
  const { address } = useAccount();
  const { writeContractAsync } = useWriteContract();
  const [assetId, setAssetId] = useState("");
  // Raw units, so the right number depends on the asset's decimals — eighteen for the equities,
  // six for the quote. Reading them from the registry rather than a table means a newly listed
  // asset gets the right default without anyone remembering to add it.
  const [units, setUnits] = useState("");
  const [typed, setTyped] = useState("1");
  const [message, setMessage] = useState<{ text: string; ok: boolean } | null>(null);
  const [minting, setMinting] = useState(false);

  const assets = vault.poolAssets;
  const decimalsOf = (id: string) => assets.find((a) => String(a.assetId) === id)?.decimals ?? 18;

  // Pick the first asset as soon as the registry answers, so the form is never submittable
  // against an empty selection.
  useEffect(() => {
    if (assetId === "" && assets.length > 0) {
      const first = String(assets[0]!.assetId);
      setAssetId(first);
      setUnits(wholeUnit(assets[0]!.decimals));
    }
  }, [assets, assetId]);

  // Keep the amount meaningful when the asset changes rather than carrying eighteen decimals'
  // worth of units over to a six-decimal token, where it is a million times the supply.
  function chooseAsset(next: string) {
    // The decimal text stays as typed — "1" means one token whichever asset it is — but the raw
    // value behind it has to be rescaled, or eighteen decimals' worth of units carries over to a
    // six-decimal token where it is a million times the supply.
    if (units === wholeUnit(decimalsOf(assetId))) setUnits(wholeUnit(decimalsOf(next)));
    else {
      const reparsed = parseAmount(typed, decimalsOf(next));
      setUnits(reparsed.raw !== undefined ? reparsed.raw.toString() : "");
    }
    setAssetId(next);
  }

  async function faucet() {
    if (!address) return;
    setMinting(true);
    setMessage(null);
    try {
      const token = vault.poolAssets.find((a) => String(a.assetId) === assetId)?.token;
      if (!token) throw new Error(`asset ${assetId} is not registered in this pool`);
      await writeContractAsync({
        address: token,
        abi: erc20Abi,
        functionName: "mint",
        args: [address, BigInt(units || "0")],
      });
      setMessage({ text: "Test tokens minted. Deposit them to create a note.", ok: true });
    } catch (e) {
      setMessage({ text: (e as Error).message, ok: false });
    } finally {
      setMinting(false);
    }
  }

  async function deposit() {
    setMessage(null);
    const result = await vault.shield(assetId, units);
    setMessage({
      text: result.ok
        ? "Deposited. Your note is in the pool and only this vault can spend it."
        : (result.reason ?? "The deposit failed."),
      ok: result.ok,
    });
  }

  return (
    <div className="vault-deposit">
      <span className="eyebrow">{t("DEPOSIT")}</span>
      <div className="sealed-order-fields">
        <label>
          <span>{t("Asset")}</span>
          <select value={assetId} onChange={(e) => chooseAsset(e.target.value)}>
            {assets.map((a) => (
              <option key={a.assetId} value={String(a.assetId)}>
                {a.assetId} — {a.symbol}
                {a.isQuote ? " (quote)" : ""}
              </option>
            ))}
          </select>
        </label>
        {feature("human-units") ? (
          <AmountField
            label={t("Amount")}
            symbol={assets.find((a) => String(a.assetId) === assetId)?.symbol}
            decimals={decimalsOf(assetId)}
            value={typed}
            onChange={(text, raw) => {
              setTyped(text);
              setUnits(raw !== undefined ? raw.toString() : "");
            }}
          />
        ) : (
          <label>
            <span>{t("Raw units")}</span>
            <input
              value={units}
              inputMode="numeric"
              onChange={(e) => setUnits(e.target.value.replace(/\D/g, ""))}
            />
          </label>
        )}
      </div>
      <div className="vault-deposit-actions">
        {/* Testnet only. The stand-in tokens have an open `mint` because there is no issuer to
            ask; the real ones have one, and a button that cannot work is worse than no button. */}
        {vault.faucetAvailable && (
          <button className="reset-demo" onClick={() => void faucet()} disabled={minting || !units}>
            {minting ? "Minting…" : "Get test tokens"}
          </button>
        )}
        <button
          className="seal-order-button"
          onClick={() => void deposit()}
          disabled={vault.shielding || !units}
        >
          <ArrowDownToLine size={16} />
          {vault.shielding ? "Depositing…" : "Deposit into the pool"}
        </button>
      </div>
      {message && (
        <p role="status" className={message.ok ? "ticket-note" : "ticket-error"}>
          {message.text}
        </p>
      )}
    </div>
  );
}

/**
 * Rebuild the vault's records from the chain.
 *
 * Finding a note means regenerating it from (epoch, counter, assetId, units). The signature
 * gives the first two; the last two live only in this browser's records — so a new browser, or
 * one whose storage was cleared, scans the tree and honestly reports nothing while the money
 * sits in it. The notes were never lost. The coordinates were.
 *
 * The chain holds the missing half, because `shield` is a public transfer and `Shielded` names
 * the asset and the amount. This reads those back and searches for the counter.
 *
 * Offered rather than run automatically: it costs a wallet-scoped log scan, and a vault that
 * already has its records does not need it. Somebody who does need it will have arrived here
 * looking at a balance of zero.
 */
/**
 * Proving the recovery works, before anything is wrong.
 *
 * `recover()` has always worked: `shield` is a public transfer, so the chain knows the asset, the
 * amount and the depositor, and the only unknown is a small counter the worker can search. What
 * it has never been is *reassuring* — it was a repair tool, worded for a repair, and the person
 * who found it was already looking at a balance of zero and wondering whether their money was
 * gone.
 *
 * That is the wrong moment to learn whether self-custody holds. So the same machinery is offered
 * as a drill: run the whole thing, change nothing, and say what would have happened. A rehearsal
 * that took a shortcut would only prove the shortcut works, so this one does not — the log scan,
 * the counter search and the regeneration inside the worker are the real ones, and the only step
 * skipped is writing the answer down.
 */
function Recover() {
  const t = useT();
  const vault = useVault();
  const [busy, setBusy] = useState<"rehearse" | "repair" | null>(null);
  const [said, setSaid] = useState<{ text: string; ok: boolean } | null>(null);

  async function run(dryRun: boolean) {
    setBusy(dryRun ? "rehearse" : "repair");
    setSaid(null);
    const r = await vault.recover({ dryRun });

    if (!r.ok) {
      setSaid({ text: r.reason ?? "Could not read the chain.", ok: false });
      setBusy(null);
      return;
    }

    const onChain = r.onChain ?? 0;
    const found = r.found ?? 0;
    const missed = onChain - found;

    if (dryRun) {
      setSaid({
        // The claim, checked rather than asserted: this browser was just wiped in principle and
        // everything came back from a signature and public logs.
        text:
          missed === 0
            ? `Rebuilt ${found} of ${onChain} deposit${onChain === 1 ? "" : "s"} from the chain and your signature alone. If you cleared this browser tomorrow, all of it would come back. Nothing was changed.`
            : `Rebuilt ${found} of ${onChain} deposits. ${missed} could not be regenerated — tell us before you rely on this, because that is the case worth understanding. Nothing was changed.`,
        ok: missed === 0,
      });
    } else {
      setSaid({
        text:
          found === 0
            ? "Nothing to recover — this vault's records are already complete."
            : `Recovered ${found} deposit${found === 1 ? "" : "s"} from the chain${
                r.alreadyKnown ? `, ${r.alreadyKnown} of which this browser already knew` : ""
              }.`,
        ok: true,
      });
    }
    setBusy(null);
  }

  return (
    <div className="vault-recover">
      <p className="ticket-note">
        {t(
          "Your notes are found using records this browser keeps. The chain holds everything needed to rebuild those records — a deposit is a public transfer, so it knows the asset, the amount and who sent it, and your signature supplies the rest.",
        )}
      </p>
      <div className="vault-deposit-actions">
        <button
          className="seal-order-button"
          onClick={() => void run(true)}
          disabled={busy !== null}
        >
          <ShieldCheck size={15} />
          {busy === "rehearse" ? t("Reading the chain…") : t("Test your recovery")}
        </button>
        <button className="reset-demo" onClick={() => void run(false)} disabled={busy !== null}>
          {busy === "repair" ? t("Reading the chain…") : t("Rebuild my records")}
        </button>
      </div>
      {said && (
        <p role="status" className={said.ok ? "ticket-note" : "ticket-error"}>
          {said.text}
        </p>
      )}
      {!said && (
        <p className="ticket-note">
          {t(
            "Testing changes nothing. It runs the real recovery and reports what would have come back — which is worth knowing now rather than on the day a browser is cleared.",
          )}
        </p>
      )}
    </div>
  );
}
