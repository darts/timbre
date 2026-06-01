import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const platform = process.argv[2] ?? process.env.TIMBRE_ARTIFACT_PLATFORM ?? "unknown";
const bundleDir = path.join(root, "src-tauri", "target", "release", "bundle");
const outputPath = path.join(bundleDir, `${platform}-SHA256SUMS.txt`);
const artifactExtensions = new Set([".dmg", ".msi", ".exe", ".deb", ".rpm", ".appimage", ".zip"]);

function walk(dir, results = []) {
  for (const entry of readdirSync(dir)) {
    const fullPath = path.join(dir, entry);
    const stat = statSync(fullPath);
    if (stat.isDirectory()) {
      walk(fullPath, results);
    } else if (artifactExtensions.has(path.extname(entry).toLowerCase())) {
      results.push(fullPath);
    }
  }
  return results;
}

if (!existsSync(bundleDir)) {
  console.error(`Bundle directory not found: ${bundleDir}`);
  process.exit(1);
}

const files = walk(bundleDir).sort();
if (files.length === 0) {
  console.error(`No checksumable artifacts found under ${bundleDir}`);
  process.exit(1);
}

const lines = files.map((filePath) => {
  const hash = createHash("sha256").update(readFileSync(filePath)).digest("hex");
  const relative = path.relative(bundleDir, filePath).split(path.sep).join("/");
  return `${hash}  ${relative}`;
});

mkdirSync(bundleDir, { recursive: true });
writeFileSync(outputPath, `${lines.join("\n")}\n`);
console.log(`Wrote ${path.relative(root, outputPath)} for ${files.length} artifact(s).`);
