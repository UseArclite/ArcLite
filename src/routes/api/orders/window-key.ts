import { createFileRoute } from "@tanstack/react-router";
import { resolveChainId } from "@/lib/chain/chains";
import { hasDb } from "@/server/db";
import { openWindowRow, windowSealingKey } from "@/server/orders";

/**
 * The public key the current window's orders must be sealed to.
 *
 * Public and unauthenticated: it is a public key, and requiring a session to fetch one would
 * tell us who is about to trade.
 *
 * `sealMode` is returned honestly, in words rather than as a flag to be looked up. Under
 * `KEYPAIR` the operator holds the matching secret and can decrypt at any time — it is transport
 * privacy, not timelock — and the response says exactly that. A client that cares can refuse to
 * submit under the weaker mode, which it cannot do if we do not tell it which is in force.
 */
export const Route = createFileRoute("/api/orders/window-key")({
  server: {
    handlers: {
      GET: async () => {
        if (!hasDb()) {
          return Response.json(
            { window: null, reason: "no_database" },
            { headers: { "cache-control": "no-store" } },
          );
        }
        try {
          const window = await openWindowRow(resolveChainId());
          if (!window) {
            return Response.json(
              { window: null, reason: "no open window" },
              { headers: { "cache-control": "no-store" } },
            );
          }

          const { publicKey, mode } = await windowSealingKey(window.id);

          return Response.json(
            {
              windowSeq: window.seq,
              // What a spend signature has to be bound to, and it is **not** `windowSeq`.
              //
              // The circuit verifies the signature against the window id the *pool* knows, which
              // is a timestamp, while `seq` is a per-chain counter starting at 1. Signing the
              // wrong one produces an order that submits, seals, prices and matches, and then
              // fails the one constraint nobody is watching — long after the trader has gone.
              chainWindowId: window.chainWindowId,
              sealsAt: window.sealsAt,
              serverNow: new Date().toISOString(),
              publicKey: `0x${Buffer.from(publicKey).toString("hex")}`,
              sealMode: mode,
              // Said in words, not just a flag, because the difference is the whole privacy
              // argument and an integrator should not have to infer it.
              sealNote:
                mode === "TLOCK"
                  ? "Orders are encrypted to a drand round. Nobody, including the operator, can decrypt before it publishes."
                  : "Orders are encrypted to a per-window key the operator holds. This is transport privacy only: it keeps your order from other traders and from anyone reading the network, and it does not keep it from the operator, who can decrypt at any time. Timelock mode is what makes early decryption impossible rather than merely against policy.",
            },
            { headers: { "cache-control": "no-store" } },
          );
        } catch (error) {
          return Response.json(
            { window: null, error: (error as Error).message },
            { status: 503, headers: { "cache-control": "no-store" } },
          );
        }
      },
    },
  },
});
