import { execFileSync } from "node:child_process";
import {
  mkdir,
  readFile,
  readdir,
  writeFile,
  copyFile,
  rm,
} from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { randomBytes } from "node:crypto";
for (const key of [
  "IOS_CERT_BASE64",
  "IOS_CERT_PASSWORD",
  "IOS_PROFILE_BASE64",
  "IOS_TEAM_ID",
  "RUNNER_TEMP",
  "VERSION",
])
  if (!process.env[key])
    throw new Error(`${key} required for signed iOS delivery`);
if (!/^[A-Z0-9]{10}$/.test(process.env.IOS_TEAM_ID))
  throw new Error("Invalid team identifier");
const directory = path.join(process.env.RUNNER_TEMP, "compositor-ios-signing");
await mkdir(directory, { recursive: true });
const keychain = path.join(directory, "release.keychain-db"),
  certificate = path.join(directory, "certificate.p12"),
  profile = path.join(directory, "profile.mobileprovision");
const password = randomBytes(32).toString("hex");
const run = (command, args) =>
  execFileSync(command, args, { stdio: ["ignore", "pipe", "pipe"] });
await writeFile(
  certificate,
  Buffer.from(process.env.IOS_CERT_BASE64, "base64"),
  { mode: 0o600 },
);
await writeFile(
  profile,
  Buffer.from(process.env.IOS_PROFILE_BASE64, "base64"),
  { mode: 0o600 },
);
const original =
  run("security", ["list-keychains", "-d", "user"])
    .toString()
    .match(/"([^"]+)"/g)
    ?.map((value) => value.slice(1, -1)) ?? [];
let installedProfile;
try {
  run("security", ["create-keychain", "-p", password, keychain]);
  run("security", ["unlock-keychain", "-p", password, keychain]);
  run("security", [
    "import",
    certificate,
    "-k",
    keychain,
    "-P",
    process.env.IOS_CERT_PASSWORD,
    "-T",
    "/usr/bin/codesign",
  ]);
  run("security", [
    "set-key-partition-list",
    "-S",
    "apple-tool:,apple:",
    "-k",
    password,
    keychain,
  ]);
  run("security", [
    "list-keychains",
    "-d",
    "user",
    "-s",
    ...original,
    keychain,
  ]);
  const decoded = run("security", ["cms", "-D", "-i", profile]);
  const decodedPath = path.join(directory, "profile.plist");
  await writeFile(decodedPath, decoded);
  const uuid = run("/usr/libexec/PlistBuddy", [
    "-c",
    "Print :UUID",
    decodedPath,
  ])
    .toString()
    .trim();
  if (!/^[A-Fa-f0-9-]{36}$/.test(uuid))
    throw new Error("Invalid provisioning profile");
  const profiles = path.join(
    os.homedir(),
    "Library/MobileDevice/Provisioning Profiles",
  );
  await mkdir(profiles, { recursive: true });
  installedProfile = path.join(profiles, `${uuid}.mobileprovision`);
  await copyFile(profile, installedProfile);
  const options = path.join(directory, "ExportOptions.plist");
  await writeFile(
    options,
    `<?xml version="1.0"?><plist version="1.0"><dict><key>method</key><string>release-testing</string><key>teamID</key><string>${process.env.IOS_TEAM_ID}</string><key>signingStyle</key><string>manual</string><key>provisioningProfiles</key><dict><key>com.bgssai.compositor</key><string>${uuid}</string></dict></dict></plist>`,
  );
  run("xcodebuild", [
    "-project",
    "clients/ios/App/App.xcodeproj",
    "-scheme",
    "App",
    "-configuration",
    "Release",
    "-destination",
    "generic/platform=iOS",
    "-archivePath",
    path.join(directory, "App.xcarchive"),
    `DEVELOPMENT_TEAM=${process.env.IOS_TEAM_ID}`,
    "CODE_SIGN_STYLE=Manual",
    `PROVISIONING_PROFILE_SPECIFIER=${uuid}`,
    "CODE_SIGN_IDENTITY=Apple Distribution",
    "archive",
  ]);
  const output = path.join(directory, "export");
  run("xcodebuild", [
    "-exportArchive",
    "-archivePath",
    path.join(directory, "App.xcarchive"),
    "-exportOptionsPlist",
    options,
    "-exportPath",
    output,
  ]);
  const ipa = (await readdir(output)).find((value) => value.endsWith(".ipa"));
  if (!ipa) throw new Error("Signed IPA missing");
  await mkdir("release", { recursive: true });
  await copyFile(
    path.join(output, ipa),
    `release/BGSSAI-Compositor-${process.env.VERSION}-ios-arm64.ipa`,
  );
} finally {
  run("security", ["list-keychains", "-d", "user", "-s", ...original]);
  try {
    run("security", ["delete-keychain", keychain]);
  } catch {}
  if (installedProfile) await rm(installedProfile, { force: true });
  if (
    path.dirname(path.resolve(directory)) !==
    path.resolve(process.env.RUNNER_TEMP)
  )
    throw new Error("Unsafe signing directory");
  await rm(directory, { recursive: true, force: true });
}
