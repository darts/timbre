#!/usr/bin/env node
// Regenerate Timbre's platform app icons from src-tauri/icons/icon.png.
// macOS gets the Apple squircle mask (rounded corners, transparent outside);
// Windows keeps the full square. Drives `tauri icon` twice and stitches the
// platform-specific outputs together.

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, copyFileSync, renameSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import sharp from "sharp";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");
const iconsDir = resolve(repoRoot, "src-tauri", "icons");
const tmpDir = resolve(iconsDir, ".tmp");
const masterSrc = resolve(iconsDir, "icon.png");

// Apple's app-icon squircle is a continuous-curvature superellipse; a plain
// rounded rectangle with r = 22.37% of side is the de-facto community stand-in
// and is visually indistinguishable in app-icon contexts. Apple's icon grid
// template puts the visible squircle in an 824×824 region centered on the 1024
// canvas, leaving 100px of transparent padding on each side — without this
// inset the icon visually overpowers other Dock icons.
const CANVAS = 1024;
const VISIBLE = 824;
const PAD = (CANVAS - VISIBLE) / 2;
const RADIUS_RATIO = 0.2237;

async function buildMaskedSources() {
  if (!existsSync(masterSrc)) {
    throw new Error(`master icon not found at ${masterSrc}`);
  }
  rmSync(tmpDir, { recursive: true, force: true });
  mkdirSync(tmpDir, { recursive: true });

  const winPath = resolve(tmpDir, "icon-windows.png");
  const macPath = resolve(tmpDir, "icon-macos.png");

  await sharp(masterSrc)
    .resize(CANVAS, CANVAS, { fit: "fill" })
    .png()
    .toFile(winPath);

  const r = Math.round(VISIBLE * RADIUS_RATIO);
  const mask = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${VISIBLE}" height="${VISIBLE}">` +
      `<rect x="0" y="0" width="${VISIBLE}" height="${VISIBLE}" rx="${r}" ry="${r}" fill="white"/>` +
      `</svg>`
  );
  const squircled = await sharp(masterSrc)
    .resize(VISIBLE, VISIBLE, { fit: "fill" })
    .composite([{ input: mask, blend: "dest-in" }])
    .png()
    .toBuffer();

  await sharp({
    create: {
      width: CANVAS,
      height: CANVAS,
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    },
  })
    .composite([{ input: squircled, top: PAD, left: PAD }])
    .png()
    .toFile(macPath);

  return { winPath, macPath };
}

function runTauriIcon(srcPath) {
  const result = spawnSync(
    "npx",
    ["--yes", "tauri", "icon", srcPath, "--output", iconsDir],
    { cwd: repoRoot, stdio: "inherit" }
  );
  if (result.status !== 0) {
    throw new Error(`tauri icon failed for ${srcPath} (exit ${result.status})`);
  }
}

async function main() {
  const { winPath, macPath } = await buildMaskedSources();

  // First pass: macOS-shaped source. Stash the resulting .icns.
  runTauriIcon(macPath);
  const stashedIcns = resolve(tmpDir, "icon.icns");
  copyFileSync(resolve(iconsDir, "icon.icns"), stashedIcns);

  // Second pass: square source for .ico, Square*Logo.png, iOS, Android, and the
  // window-icon PNGs referenced by tauri.conf.json.
  runTauriIcon(winPath);

  // Restore the macOS-shaped .icns over the second-pass output.
  renameSync(stashedIcns, resolve(iconsDir, "icon.icns"));

  rmSync(tmpDir, { recursive: true, force: true });
  console.log("icons rebuilt: macOS .icns squircled, Windows .ico left square");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
