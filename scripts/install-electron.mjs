// Electron 44's native ZIP extractor cannot load on some Windows installations.
// Use its official, checksum-verified download with Windows' built-in ZIP extractor.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createRequire } from "node:module";
import { access, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

if (
  process.env.ELECTRON_SKIP_BINARY_DOWNLOAD === "1" ||
  process.env.NODE_ENV === "production"
)
  process.exit(0);
const require = createRequire(import.meta.url);
const root = dirname(require.resolve("electron/package.json"));
if (process.platform !== "win32") { await import('electron/install.js'); process.exit(0); }
const { version } = require("electron/package.json");
const executable =
  process.platform === "win32"
    ? "electron.exe"
    : process.platform === "darwin"
      ? "Electron.app/Contents/MacOS/Electron"
      : "electron";
try {
  await access(join(root, "dist", executable));
  if (
    (await readFile(join(root, "dist/version"), "utf8"))
      .trim()
      .replace(/^v/, "") === version
  ) {
    await writeFile(join(root, "path.txt"), executable);
    process.exit(0);
  }
} catch {
  /* First installation. */
}
const { downloadArtifact } = await import("@electron/get");
const zip = await downloadArtifact({
  version,
  artifactName: "electron",
  platform: process.platform,
  arch: process.arch,
  checksums: require("electron/checksums.json"),
});
await promisify(execFile)(
  "powershell.exe",
  [
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    "Expand-Archive -LiteralPath $env:COMPOSITOR_ZIP_PATH -DestinationPath $env:COMPOSITOR_DIST_PATH -Force",
  ],
  {
    windowsHide: true,
    env: {
      ...process.env,
      COMPOSITOR_ZIP_PATH: zip,
      COMPOSITOR_DIST_PATH: join(root, "dist"),
    },
  },
);
try {
  await rename(join(root, "dist/electron.d.ts"), join(root, "electron.d.ts"));
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}
await writeFile(join(root, "path.txt"), executable);
console.log(
  `Electron ${version} installed for ${process.platform}/${process.arch}.`,
);
