import { createFileRoute } from "@tanstack/react-router";
import { resolveChainId } from "@/lib/chain/chains";
import { hasDb } from "@/server/db";
import { MAX_ORDERS_PER_ACCOUNT, submitOrder } from "@/server/orders";

/**
 * Sealed order intake.
 *
 * **No session, and that is deliberate.** This route reads no cookie and takes no address. A
 * cookie here would put the address↔order link into our own request logs — the exact linkage the
 * venue exists to remove — so clients fetch it with `credentials: 'omit'` and authenticate by the
 * signature inside the sealed payload instead.
 *
 * The residual leak is the source IP, and no Vercel-only design fixes that. It is documented in
 * `plan.md` rather than described away.
 *
 * Everything validated here is validated **without decrypting the payload**: an operator that had
 * to read an order to decide whether to accept it would see the whole book as it arrived.
 */

const HEX = (length: number) => new RegExp(`^0x[0-9a-fA-F]{${length}}$`);

export const Route = createFileRoute("/api/orders/submit")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const deny = (reason: string, status = 400) =>
          Response.json(
            { ok: false, reason },
            { status, headers: { "cache-control": "no-store" } },
          );

        if (!hasDb()) return deny("order intake is unavailable: no database is configured", 503);

        let body: Record<string, unknown>;
        try {
          body = (await request.json()) as Record<string, unknown>;
        } catch {
          return deny("body is not json");
        }

        const windowSeq = body.windowSeq;
        if (typeof windowSeq !== "string" || !/^\d{1,19}$/.test(windowSeq)) {
          return deny("windowSeq must be a decimal string");
        }
        for (const [field, length] of [
          ["accountHash", 64],
          ["commitment", 64],
          ["nonceHash", 64],
        ] as const) {
          if (typeof body[field] !== "string" || !HEX(length).test(body[field] as string)) {
            return deny(`${field} must be ${length / 2} hex bytes`);
          }
        }
        if (typeof body.payloadCt !== "string" || !/^0x[0-9a-fA-F]+$/.test(body.payloadCt)) {
          return deny("payloadCt must be hex");
        }
        // Matches the column bound. A body that exists only to be expensive to parse is rejected
        // before it reaches Postgres.
        if ((body.payloadCt.length - 2) / 2 > 4096) return deny("payloadCt is too large", 413);

        try {
          const result = await submitOrder({
            chainId: resolveChainId(),
            windowSeq,
            accountHash: body.accountHash as string,
            commitment: body.commitment as string,
            nonceHash: body.nonceHash as string,
            payloadCt: body.payloadCt,
          });

          if (!result.ok) {
            // The reason is specific because none of them help an attacker: a submitter already
            // knows their own window, note and order count. Vagueness here costs an honest
            // trader an afternoon.
            return Response.json(
              { ok: false, reason: result.reason, maxPerAccount: MAX_ORDERS_PER_ACCOUNT },
              { status: 409, headers: { "cache-control": "no-store" } },
            );
          }

          return Response.json(
            { ok: true, orderId: result.orderId },
            { headers: { "cache-control": "no-store" } },
          );
        } catch (error) {
          return deny((error as Error).message, 500);
        }
      },
    },
  },
});
