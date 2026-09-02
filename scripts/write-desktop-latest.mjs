import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Keep in sync with src/version.ts and src-tauri expected_build.
const version = "0.1.0";
const build = "2026.08.17-github-changes";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const appPath = path.join(
  root,
  "src-tauri/target/release/bundle/macos/Agent Team.app",
);
const destinations = [
  path.join(root, "src-tauri/target/release/bundle/macos/latest.json"),
  path.join(root, "desktop-latest.json"),
];

const manifest = {
  version,
  build,
  appPath,
  publishedAt: new Date().toISOString(),
};

for (const destination of destinations) {
  await mkdir(path.dirname(destination), { recursive: true });
  await writeFile(destination, `${JSON.stringify(manifest, null, 2)}\n`);
}

process.stdout.write(`Wrote desktop latest manifest ${build} -> ${destinations.join(", ")}\n`);
