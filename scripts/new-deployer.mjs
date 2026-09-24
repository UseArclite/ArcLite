// Generate the testnet deployer key and store it in .env.local.
//
// The private key is written to the file and never printed. Anything printed to a terminal ends
// up in scrollback, shell history adjacent logs, and any transcript of the session — so the only
// thing that leaves this script is the address.
//
// Refuses to overwrite an existing key. Re-running after funding would otherwise silently
// orphan whatever is already in the old account, with no error to notice.
//
//   bun scripts/new-deployer.mjs [--role DEPLOYER]
import { appendFileSync, chmodSync, existsSync, readFileSync } from "node:fs";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

const flag = process.argv.indexOf("--role");
// `indexOf` returns -1 when the flag is absent, and argv[0] is the interpreter path — so the
// naive `argv[indexOf(...) + 1]` silently names the key after the bun binary.
const role = (flag === -1 ? "DEPLOYER" : (process.argv[flag + 1] ?? "DEPLOYER")).toUpperCase();
if (!/^[A-Z][A-Z0-9_]*$/.test(role)) {
  console.error(`"${role}" is not a usable env-var name.`);
  process.exit(1);
}
const name = `${role}_PRIVATE_KEY`;
const file = ".env.local";

if (!existsSync(file)) {
  console.error(`${file} does not exist — create it first so its permissions are deliberate.`);
  process.exit(1);
}

const current = readFileSync(file, "utf8");
if (new RegExp(`^${name}=`, "m").test(current)) {
  const existing = current.match(new RegExp(`^${name}=(0x[0-9a-fA-F]{64})`, "m"));
  console.error(`${name} already exists in ${file}. Refusing to overwrite.`);
  if (existing) {
    console.error(`Its address is ${privateKeyToAccount(existing[1]).address}`);
  }
  process.exit(1);
}

// viem's generatePrivateKey uses the platform CSPRNG (crypto.getRandomValues).
const privateKey = generatePrivateKey();
const account = privateKeyToAccount(privateKey);

appendFileSync(
  file,
  `\n# ${role} — testnet only (chain 46630). Generated ${new Date().toISOString().slice(0, 10)}.\n` +
    `# Address: ${account.address}\n` +
    `${name}=${privateKey}\n`,
);
chmodSync(file, 0o600);

console.log(`${role} address: ${account.address}`);
console.log(`Private key written to ${file} (chmod 600, gitignored). Not printed anywhere.`);
