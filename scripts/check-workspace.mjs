import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const command = process.argv[2] ?? "check";
const root = process.cwd();
const packagesDir = join(root, "packages");

if (!existsSync(packagesDir)) {
  console.error("Missing packages directory");
  process.exit(1);
}

const packages = readdirSync(packagesDir, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();

const expected = ["core", "providers", "server", "tui", "web"];
const missing = expected.filter((name) => !packages.includes(name));

if (missing.length > 0) {
  console.error(`Missing workspace packages: ${missing.join(", ")}`);
  process.exit(1);
}

for (const name of expected) {
  const manifestPath = join(packagesDir, name, "package.json");

  if (!existsSync(manifestPath)) {
    console.error(`Missing package manifest: packages/${name}/package.json`);
    process.exit(1);
  }

  JSON.parse(readFileSync(manifestPath, "utf8"));
}

console.log(`${command}: workspace baseline ok`);
