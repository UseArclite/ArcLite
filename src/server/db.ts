import postgres from "postgres";

/**
 * Postgres access for server routes and crons.
 *
 * Two things shape this file.
 *
 * Supavisor's **transaction** pooler (port 6543) does not support prepared statements; omitting
 * `prepare: false` fails intermittently rather than loudly, which is the worst kind of bug. The
 * **session** pooler (5432) does support them and is what migrations and long-running crons use.
 * `DATABASE_URL` selects which, and `prepare` follows the port rather than being guessed.
 *
 * The database is currently in ap-southeast-1 while functions run in iad1 — ~230-260ms per round
 * trip. Everything here is therefore written as **one statement per operation**, with bulk
 * upserts rather than row-at-a-time loops. That is good practice anyway; here it is the
 * difference between a tick taking 300ms and taking 5s.
 */

let client: ReturnType<typeof postgres> | null = null;

export function db() {
  if (client) return client;

  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set");

  const isTransactionPooler = url.includes(":6543");

  // Supabase terminates TLS at the pooler, so TLS is required there and must not be negotiable.
  // A local Postgres has no TLS at all, and hardcoding `require` made it impossible to run the
  // server against one — which is how the SIWE flow gets verified end to end before deploying.
  // `sslmode=disable` in the URL is the explicit opt-out; anything else stays required.
  const sslDisabled = /[?&]sslmode=disable\b/.test(url);

  client = postgres(url, {
    prepare: !isTransactionPooler,
    // A serverless instance handles few concurrent requests but is reused across invocations;
    // a small pool avoids exhausting Supabase's connection limit under fan-out.
    max: 3,
    idle_timeout: 20,
    connect_timeout: 15,
    ssl: sslDisabled ? false : "require",
    onnotice: () => {},
  });
  return client;
}

/** True when a database is configured at all — lets routes degrade instead of throwing. */
export function hasDb(): boolean {
  return Boolean(process.env.DATABASE_URL);
}

export interface LockResult {
  acquired: boolean;
  holder: string;
}

/**
 * Cron mutual exclusion. Returns false when another invocation holds an unexpired lease — the
 * caller should return 200 immediately, never 500, or Vercel retries and floods the logs.
 */
export async function tryLock(name: string, ttlSeconds: number): Promise<LockResult> {
  const holder = `${process.env.VERCEL_DEPLOYMENT_ID ?? "local"}:${crypto.randomUUID()}`;
  const sql = db();
  const rows = await sql<{ ok: boolean }[]>`
    select arclite.try_lock(${name}, ${holder}, ${ttlSeconds}) as ok
  `;
  return { acquired: rows[0]?.ok === true, holder };
}

export async function releaseLock(name: string): Promise<void> {
  const sql = db();
  await sql`update arclite.cron_locks set lease_until = now() where name = ${name}`;
}

export async function recordRun(
  name: string,
  holder: string,
  ok: boolean,
  actions: Record<string, string | number | boolean | null>,
  error?: string,
): Promise<void> {
  const sql = db();
  await sql`
    insert into arclite.cron_runs (name, holder, finished_at, ok, actions, error)
    values (${name}, ${holder}, now(), ${ok}, ${sql.json(actions)}, ${error ?? null})
  `;
}
