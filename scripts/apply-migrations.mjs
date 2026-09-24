// Apply every migration that is not yet recorded as applied.
//
// There was no runner. Migrations were written, validated against a throwaway local Postgres by
// `validate-migrations.sh`, and then applied to Supabase by hand — so one being forgotten was a
// matter of time. `0008_note_units.sql` was, and the symptom was orders rejected at reveal with
// `function arclite.reveal_order(...) does not exist`: a message that names a function, not a
// missing deployment step, and that only appears once an order has already been accepted and
// sealed. The trader sees nothing until the window closes.
//
// Idempotent: a ledger table records what has run, so re-running applies only what is new. Each
// file runs inside its own transaction, so a failure leaves the database on the last good
// migration rather than half-way through a broken one.
//
//   bun scripts/apply-migrations.mjs             # apply what is pending
//   bun scripts/apply-migrations.mjs --check     # list pending, change nothing
//   bun scripts/apply-migrations.mjs --baseline  # record every file as applied, run nothing
//
// `--baseline` exists for exactly one moment: adopting a database whose migrations were applied
// by hand, where the ledger is empty but the schema is current. Running it on a database that is
// genuinely behind would mark migrations as applied that never ran, which is worse than having
// no ledger at all — so it is a deliberate one-off, not part of a deploy.
import { readdirSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import postgres from "postgres";

const DIR = "supabase/migrations";
const check = process.argv.includes("--check");
const baseline = process.argv.includes("--baseline");

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is not set");
// `prepare: false` for Supavisor's transaction pooler, which does not support prepared
// statements and fails intermittently rather than loudly if you forget.
const sql = postgres(url, { prepare: false, onnotice: () => {} });

await sql.unsafe(`
  create schema if not exists arclite;
  create table if not exists arclite.schema_migrations (
    name        text primary key,
    sha256      text not null,
    applied_at  timestamptz not null default now()
  );
`);

const applied = new Map(
  (await sql.unsafe("select name, sha256 from arclite.schema_migrations")).map((r) => [
    r.name,
    r.sha256,
  ]),
);

const files = readdirSync(DIR)
  .filter((f) => f.endsWith(".sql"))
  .sort();

let ran = 0;
for (const name of files) {
  const body = readFileSync(`${DIR}/${name}`, "utf8");
  const sha = createHash("sha256").update(body).digest("hex");
  const seen = applied.get(name);

  if (seen === sha) continue;
  if (seen) {
    // A migration that changed after being applied is a different migration wearing the same
    // name. Refusing is the only safe answer: re-running it could be destructive, and skipping
    // it leaves the database describing itself incorrectly.
    console.error(`${name}: already applied, but its contents changed. Write a new migration.`);
    process.exit(1);
  }

  if (check) {
    console.log(`pending  ${name}`);
    ran += 1;
    continue;
  }

  if (baseline) {
    await sql.unsafe("insert into arclite.schema_migrations (name, sha256) values ($1, $2)", [
      name,
      sha,
    ]);
    console.log(`recorded ${name} (not run)`);
    ran += 1;
    continue;
  }

  process.stdout.write(`applying ${name} … `);
  try {
    await sql.begin(async (tx) => {
      await tx.unsafe(body);
      await tx.unsafe("insert into arclite.schema_migrations (name, sha256) values ($1, $2)", [
        name,
        sha,
      ]);
    });
    console.log("ok");
    ran += 1;
  } catch (error) {
    console.log("failed");
    console.error(`  ${error.message}`);
    // Everything before this one is committed and recorded. Stopping here leaves the database on
    // the last good migration rather than part-way through a broken one.
    await sql.end();
    process.exit(1);
  }
}

await sql.end();
console.log(
  ran === 0
    ? `up to date — ${files.length} migration(s) applied`
    : check
      ? `${ran} pending`
      : baseline
        ? `recorded ${ran} migration(s) without running them`
        : `applied ${ran} migration(s)`,
);
process.exit(check && ran > 0 ? 1 : 0);
