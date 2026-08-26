import { readdir, readFile, stat } from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const docsRoot = join(root, "docs");
const failures = [];

const docs = [
  ...await existingRootDocs(),
  ...await markdownFiles(docsRoot),
];

for (const path of docs) await checkLocalLinks(path);
await checkDocumentationInventory();
await checkVersionFacts();
await checkAdrStatuses();

if (failures.length > 0) {
  for (const failure of failures) console.error(`- ${failure}`);
  console.error(`Documentation check failed with ${failures.length} issue(s).`);
  process.exit(1);
}

console.log(`Documentation check passed for ${docs.length} Markdown files.`);

async function existingRootDocs() {
  const candidates = ["README.md", "AGENTS.md", "PRODUCT.md"].map((name) => join(root, name));
  const found = [];
  for (const path of candidates) {
    if (await exists(path)) found.push(path);
  }
  return found;
}

async function markdownFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const paths = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) paths.push(...await markdownFiles(path));
    else if (entry.isFile() && entry.name.endsWith(".md")) paths.push(path);
  }
  return paths.sort();
}

async function checkLocalLinks(path) {
  const source = await readFile(path, "utf8");
  const links = source.matchAll(/!?\[[^\]]*\]\(([^)]+)\)/g);
  for (const match of links) {
    const rawTarget = match[1].trim().replace(/^<|>$/g, "");
    if (!rawTarget || rawTarget.startsWith("#") || /^[a-z][a-z0-9+.-]*:/i.test(rawTarget)) continue;
    const target = decodeURIComponent(rawTarget.split("#", 1)[0].split("?", 1)[0]);
    const resolved = resolve(dirname(path), target);
    if (!await exists(resolved)) {
      failures.push(`${display(path)} links to missing ${rawTarget}`);
    }
  }
}

async function checkDocumentationInventory() {
  const index = await readFile(join(docsRoot, "README.md"), "utf8");
  const topLevel = (await markdownFiles(docsRoot)).filter((path) =>
    dirname(path) === docsRoot && basename(path) !== "README.md"
  );
  for (const path of topLevel) {
    if (!index.includes(`(${basename(path)})`)) {
      failures.push(`docs/README.md does not classify ${basename(path)}`);
    }
  }

  const adrIndex = await readFile(join(docsRoot, "adr", "README.md"), "utf8");
  const adrs = (await markdownFiles(join(docsRoot, "adr"))).filter((path) => basename(path) !== "README.md");
  for (const path of adrs) {
    if (!adrIndex.includes(`(${basename(path)})`)) {
      failures.push(`docs/adr/README.md does not list ${basename(path)}`);
    }
  }
}

async function checkVersionFacts() {
  const versionSource = await readFile(join(root, "packages", "core", "src", "version.ts"), "utf8");
  const version = versionSource.match(/TOTEMORA_VERSION = "([^"]+)"/)?.[1];
  const release = versionSource.match(/TOTEMORA_RELEASE = "([^"]+)"/)?.[1];
  if (!version || !release) {
    failures.push("packages/core/src/version.ts does not expose recognizable version constants");
    return;
  }

  const packageVersion = JSON.parse(await readFile(join(root, "package.json"), "utf8")).version;
  if (packageVersion !== version) {
    failures.push(`package.json version ${packageVersion} differs from core version ${version}`);
  }

  const index = await readFile(join(docsRoot, "README.md"), "utf8");
  const productVersion = `${version}-${release}`;
  if (!index.includes(`\`${version}\``) || !index.includes(`\`${productVersion}\``)) {
    failures.push(`docs/README.md must state ${version} and ${productVersion}`);
  }
}

async function checkAdrStatuses() {
  const adrs = (await markdownFiles(join(docsRoot, "adr"))).filter((path) => basename(path) !== "README.md");
  for (const path of adrs) {
    const source = await readFile(path, "utf8");
    if (!/(?:状态|Status)[\s\S]{0,80}\b(?:Accepted|Proposed|Deprecated|Superseded|Rejected)\b/i.test(source)) {
      failures.push(`${display(path)} does not declare a recognized ADR status`);
    }
  }
}

async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

function display(path) {
  return relative(root, path) || ".";
}
