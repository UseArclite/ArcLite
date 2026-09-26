"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { Bell, BellOff, BellRing } from "lucide-react";
import { useMarket, useWindow } from "./market-provider";
import {
  addWatch,
  fireWatches,
  pruneWatches,
  removeWatch,
  watchId,
  type MarketView,
  type Watch,
} from "../lib/reminders";
import { Detail } from "./panel-detail";
import { useT } from "../lib/i18n";

/**
 * Tell me when, without telling anyone what I am waiting for.
 *
 * An asset can sit deferred for hours — a feed goes stale outside its session and clears on the
 * next round — and the useful thing is being told when that ends rather than checking. Same for
 * a window about to seal: orders submitted after it wait for the next one.
 *
 * **Nothing here leaves the browser.** The obvious build is a server holding the watch list and
 * pushing when a condition clears, and that server would know which assets somebody intends to
 * trade and roughly when. Orders are salted per window precisely so they cannot be linked across
 * windows; a watch list in our database would hand back what the sealing was protecting. So
 * watches live in `localStorage`, conditions are evaluated against data this page already polls,
 * and the honest cost — it only fires while the tab is open — is stated rather than buried.
 *
 * Permission is requested from a click and nowhere else, the same rule the settlement alerts
 * follow: a site that asks on load gets denied and then cannot ask again.
 */

const KEY = "arclite-watches-v1";

function load(): Watch[] {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? pruneWatches(JSON.parse(raw) as Watch[], Date.now()) : [];
  } catch {
    // Private windows and blocked site data land here. Losing a watch list loses a convenience.
    return [];
  }
}

function save(watches: Watch[]) {
  try {
    localStorage.setItem(KEY, JSON.stringify(watches));
  } catch {
    /* see load */
  }
}

type Permission = "default" | "granted" | "denied" | "unsupported";

export function Reminders({ symbol }: { symbol: string }) {
  const t = useT();
  const market = useMarket();
  const { window: live, secondsToSeal } = useWindow();

  const [watches, setWatches] = useState<Watch[]>([]);
  const [permission, setPermission] = useState<Permission>("default");
  const previous = useRef<MarketView | null>(null);

  useEffect(() => {
    setWatches(load());
    setPermission(
      typeof Notification === "undefined" ? "unsupported" : (Notification.permission as Permission),
    );
  }, []);

  const update = useCallback((next: Watch[]) => {
    setWatches(next);
    save(next);
  }, []);

  // The whole engine: build the current view, compare it with the last one, fire what transitioned
  // and drop those watches. One-shot by construction — a watch that survived its own firing would
  // notify on every poll for as long as the condition held.
  useEffect(() => {
    if (!market.snapshot) return;
    const current: MarketView = {
      deferred: Object.fromEntries(market.snapshot.assets.map((a) => [a.symbol, a.guard.deferred])),
      secondsToSeal: live ? secondsToSeal : null,
      windowSeq: live?.seq ?? null,
    };

    const fired = fireWatches(watches, previous.current, current);
    previous.current = current;
    if (fired.length === 0) return;

    for (const f of fired) {
      if (typeof Notification !== "undefined" && Notification.permission === "granted") {
        try {
          new Notification(f.title, {
            body: f.body,
            tag: watchId(f.watch),
            icon: "/assets/sun.svg",
          });
        } catch {
          // Some browsers refuse construction outside a service worker. The watch still clears —
          // the condition happened, and re-arming it silently would fire again on the next poll.
        }
      }
    }
    update(fired.reduce((rest, f) => removeWatch(rest, watchId(f.watch)), watches));
  }, [market.snapshot, live, secondsToSeal, watches, update]);

  async function arm(watch: Watch) {
    if (typeof Notification !== "undefined" && Notification.permission === "default") {
      // From a click, never on load.
      const result = await Notification.requestPermission();
      setPermission(result as Permission);
    }
    update(addWatch(watches, watch));
  }

  const assetWatch: Watch = { kind: "undeferred", symbol, at: Date.now() };
  const sealWatch: Watch = { kind: "sealing", at: Date.now() };
  const has = (w: Watch) => watches.some((x) => watchId(x) === watchId(w));
  const deferred = market.snapshot?.assets.find((a) => a.symbol === symbol)?.guard.deferred;

  return (
    <div className="reminders">
      <div className="reminders-row">
        {/* Only offered when there is something to wait for: a bell on an asset that is already
            trading is a control that would never fire. */}
        {deferred && (
          <button
            className={"reset-demo" + (has(assetWatch) ? " is-armed" : "")}
            onClick={() =>
              has(assetWatch)
                ? update(removeWatch(watches, watchId(assetWatch)))
                : void arm(assetWatch)
            }
          >
            {has(assetWatch) ? <BellRing size={13} /> : <Bell size={13} />}
            {has(assetWatch)
              ? `${t("Watching")} ${symbol}`
              : `${t("Tell me when")} ${symbol} ${t("clears")}`}
          </button>
        )}
        <button
          className={"reset-demo" + (has(sealWatch) ? " is-armed" : "")}
          onClick={() =>
            has(sealWatch) ? update(removeWatch(watches, watchId(sealWatch))) : void arm(sealWatch)
          }
        >
          {has(sealWatch) ? <BellRing size={13} /> : <Bell size={13} />}
          {has(sealWatch) ? t("Watching the window") : t("Tell me before the window seals")}
        </button>
      </div>

      {permission === "denied" && (
        <p className="ticket-note">
          <BellOff size={12} />{" "}
          {t(
            "Notifications are blocked for this site, so nothing can be delivered. The conditions still show on this page.",
          )}
        </p>
      )}

      <Detail label={t("Where these live")}>
        <p>
          {t(
            "In this browser, and nowhere else. A server holding your watch list would know which assets you intend to trade and roughly when — and withholding exactly that is what the rest of this design is for, since orders are salted per window so they cannot be linked across them.",
          )}
        </p>
        <p>
          {t(
            "The cost of that is real: a reminder only fires while this tab is open. There is no push, no account and no email, because each of those would need somebody to be told what you are waiting for.",
          )}
        </p>
      </Detail>
    </div>
  );
}
