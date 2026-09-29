import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import {
  CollaborationService,
  COMPILER_PROMPT_VERSION,
  COMPILER_TAXONOMY_VERSION,
  SuccessfulCompilerManifestSchema,
  ensurePageId,
  hashWikiDirectory,
  loadState,
  parsePage,
  sha256,
  stableGeneratedPageId,
} from "../dist/index.js";

const vault = process.argv[2];
if (!vault) throw new Error("Usage: node scripts/curate-source-index.mjs /absolute/vault/path");

const service = new CollaborationService(vault);
const homeSnapshot = await service.readPage("Wiki/Home.md");
const parsedHome = parsePage(homeSnapshot.content);
const eligibleSources = Array.isArray(parsedHome.attributes.sources)
  ? parsedHome.attributes.sources.filter((source) => typeof source === "string")
  : [];
if (eligibleSources.length === 0) throw new Error("Home has no eligible source inventory");

const state = await loadState(vault);
const sourceHashes = new Map();
for (const source of Object.values(state.sources)) {
  if (source.generatedHash) sourceHashes.set(basename(source.path), source.generatedHash);
}

const mocDirectory = join(vault, "Wiki/MOCs");
const representative = new Set();
for (const entry of (await readdir(mocDirectory, { withFileTypes: true }))
  .filter((candidate) => candidate.isFile() && candidate.name.endsWith(".md"))
  .sort((left, right) => left.name.localeCompare(right.name))) {
  const page = parsePage(await readFile(join(mocDirectory, entry.name), "utf8"));
  const sources = Array.isArray(page.attributes.sources) ? page.attributes.sources : [];
  for (const source of sources) {
    if (typeof source === "string" && representative.size < 24) representative.add(source);
  }
}
if (representative.size === 0) representative.add(eligibleSources[0]);

const representativeList = [...representative];
const replacement = `sources:\n${representativeList.map((source) => `  - ${source}`).join("\n")}\n`;
let curatedHome = homeSnapshot.content.replace(/^sources:\n(?:  - .*\n)+/m, replacement);
if (!curatedHome.includes("[[MOCs/Source Index]]")) {
  curatedHome = curatedHome.replace(
    /\n## Cross-domain starting points/,
    "\n- [[MOCs/Source Index]] — browse every eligible Apple Notes source by title.\n\n## Cross-domain starting points",
  );
}

const catalog = [];
for (const source of eligibleSources) {
  const content = await readFile(join(vault, "Sources/Apple Notes", source), "utf8");
  const title = parsePage(content).attributes.title;
  catalog.push({
    source,
    title: (typeof title === "string" ? title : source)
      .replaceAll("|", "-")
      .replaceAll("]]", "]"),
  });
}
catalog.sort((left, right) => left.title.localeCompare(right.title));
const groups = new Map();
for (const item of catalog) {
  const first = item.title.trim().at(0)?.toUpperCase() ?? "#";
  const group = /^[A-Z0-9]$/.test(first) ? first : "#";
  const values = groups.get(group) ?? [];
  values.push(item);
  groups.set(group, values);
}
const indexBody = [...groups.entries()].map(([group, items]) => [
  `## ${group}`,
  "",
  ...items.map((item) => `- [[${item.source}|${item.title}]]`),
  "",
].join("\n")).join("\n");
const indexWithoutId = [
  "---",
  "title: Source Index",
  "summary: Alphabetical browseable index of every compiler-eligible Apple Notes source.",
  "sources:",
  ...eligibleSources.map((source) => `  - ${source}`),
  "---",
  "# Source Index",
  "",
  "This index is the lossless navigation fallback for source notes that do not yet merit their own semantic Wiki page. Topic pages remain the preferred entry points.",
  "",
  indexBody,
].join("\n");
const sourceIndex = ensurePageId(
  indexWithoutId,
  stableGeneratedPageId(indexWithoutId),
).content;

const result = await service.publishProposals([
  {
    path: "Wiki/Home.md",
    content: curatedHome,
    expectedHash: homeSnapshot.hash,
    sourceHashes: representativeList.map((source) => sourceHashes.get(source)).filter(Boolean),
  },
  {
    path: "Wiki/MOCs/Source Index.md",
    content: sourceIndex,
    sourceHashes: eligibleSources.map((source) => sourceHashes.get(source)).filter(Boolean),
  },
]);

const manifestPath = join(vault, ".ckb/compiler/current/manifest.json");
const manifestRaw = await readFile(manifestPath, "utf8");
const manifestHash = sha256(manifestRaw);
const manifest = SuccessfulCompilerManifestSchema.parse(JSON.parse(manifestRaw));
const nextManifest = SuccessfulCompilerManifestSchema.parse({
  ...manifest,
  promptVersion: COMPILER_PROMPT_VERSION,
  taxonomyVersion: COMPILER_TAXONOMY_VERSION,
  wikiHashes: await hashWikiDirectory(join(vault, "Wiki")),
});
const currentRaw = await readFile(manifestPath, "utf8");
if (sha256(currentRaw) !== manifestHash) throw new Error("Compiler manifest changed during curation");
const temporary = `${manifestPath}.curation-${process.pid}.tmp`;
await mkdir(join(vault, ".ckb/compiler/current"), { recursive: true });
await writeFile(temporary, `${JSON.stringify(nextManifest, null, 2)}\n`, { flag: "wx" });
await rename(temporary, manifestPath);

process.stdout.write(`${JSON.stringify({
  publication: result,
  homeRepresentativeSources: representativeList.length,
  indexedSources: eligibleSources.length,
  promptVersion: COMPILER_PROMPT_VERSION,
}, null, 2)}\n`);
