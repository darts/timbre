import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const requiredPlatforms = ["macos-arm64", "windows-x86_64"];
const requiredBundleTargets = ["app", "dmg", "msi", "nsis"];
const requiredBackendRequirements = ["base", "cpu", "cuda", "mps"];

const failures = [];

function readJson(relativePath) {
  const fullPath = path.join(root, relativePath);
  try {
    return JSON.parse(readFileSync(fullPath, "utf8"));
  } catch (error) {
    fail(`${relativePath}: ${(error && error.message) || error}`);
    return {};
  }
}

function fail(message) {
  failures.push(message);
}

function assert(condition, message) {
  if (!condition) fail(message);
}

function isSha256(value) {
  return typeof value === "string" && /^[a-f0-9]{64}$/i.test(value);
}

function validateResourceGlob(source) {
  const resolved = path.resolve(root, "src-tauri", source);
  const parts = resolved.split(path.sep);
  const starIndexes = parts.flatMap((part, index) => (part.includes("*") ? [index] : []));

  if (starIndexes.length === 0) {
    assert(existsSync(resolved), `resource source not found: ${source}`);
    return existsSync(resolved) ? [resolved] : [];
  }

  if (starIndexes.length !== 1) {
    fail(`resource glob must contain exactly one wildcard segment: ${source}`);
    return [];
  }

  const starIndex = starIndexes[0];
  const pattern = parts[starIndex];
  const dir = parts.slice(0, starIndex).join(path.sep) || path.sep;
  const tail = parts.slice(starIndex + 1);
  const [prefix, suffix] = pattern.split("*");

  if (!existsSync(dir)) {
    fail(`resource glob directory not found: ${source}`);
    return [];
  }

  const matches = readdirSync(dir)
    .filter((entry) => entry.startsWith(prefix) && entry.endsWith(suffix))
    .map((entry) => path.join(dir, entry, ...tail))
    .filter((entryPath) => existsSync(entryPath) && statSync(entryPath).isFile());

  assert(matches.length > 0, `resource glob matched no files: ${source}`);
  return matches;
}

function validateTauriConfig() {
  const tauri = readJson("src-tauri/tauri.conf.json");
  const targets = tauri.bundle?.targets ?? [];
  for (const target of requiredBundleTargets) {
    assert(targets.includes(target), `tauri bundle target missing: ${target}`);
  }

  const resources = tauri.bundle?.resources ?? {};
  const resourceSources = Object.keys(resources);
  assert(resourceSources.length > 0, "tauri bundle resources are empty");
  for (const source of resourceSources) {
    validateResourceGlob(source);
  }
}

function validateDownloadManifest() {
  const manifest = readJson("resources/python-build-standalone.urls.json");
  for (const platform of requiredPlatforms) {
    assert(Boolean(manifest.platforms?.[platform]), `runtime download platform missing: ${platform}`);
  }

  for (const [platform, assets] of Object.entries(manifest.platforms ?? {})) {
    for (const assetKind of ["python", "uv"]) {
      const asset = assets?.[assetKind];
      assert(Boolean(asset?.url), `${platform}.${assetKind}.url missing`);
      assert(
        typeof asset?.url === "string" && asset.url.startsWith("https://"),
        `${platform}.${assetKind}.url must be https`,
      );
      assert(isSha256(asset?.sha256), `${platform}.${assetKind}.sha256 must be a 64-char hex digest`);
    }
  }

  assert(manifest.torch_index_urls?.cpu?.startsWith("https://"), "cpu torch index URL missing");
  assert(manifest.torch_index_urls?.cuda?.startsWith("https://"), "cuda torch index URL missing");
  assert(manifest.torch_index_urls?.mps === null, "mps torch index URL should stay null");
}

function validateRequirementsAndModels() {
  for (const name of requiredBackendRequirements) {
    assert(existsSync(path.join(root, "py", "requirements", `${name}.txt`)), `requirements file missing: ${name}.txt`);
  }

  const models = readJson("resources/models.manifest.json").models ?? [];
  assert(models.length > 0, "models manifest contains no models");
  const adapters = new Set(models.map((model) => model.adapter).filter(Boolean));
  for (const adapter of adapters) {
    assert(
      existsSync(path.join(root, "py", "requirements", `${adapter}.txt`)),
      `adapter requirements file missing: ${adapter}.txt`,
    );
  }
}

validateTauriConfig();
validateDownloadManifest();
validateRequirementsAndModels();

if (failures.length > 0) {
  console.error("Release input validation failed:");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log(`Release input validation passed for ${requiredPlatforms.join(", ")}.`);
