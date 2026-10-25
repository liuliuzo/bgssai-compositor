import { test } from "node:test";
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";

const workflowsDir = new URL("../.github/workflows/", import.meta.url);

function jobLevelEnv(text: string): Map<string, string[]> {
  const result = new Map<string, string[]>();
  let inJobs = false;
  let jobsIndent = -1;
  let job: string | null = null;
  let jobIndent = -1;
  let envIndent = -1;
  let collecting = false;
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim() || line.trim().startsWith("#")) continue;
    const indent = line.length - line.trimStart().length;
    const stripped = line.trim();
    if (!inJobs) {
      if (stripped === "jobs:") {
        inJobs = true;
        jobsIndent = indent;
      }
      continue;
    }
    if (indent <= jobsIndent) {
      inJobs = false;
      job = null;
      collecting = false;
      continue;
    }
    if (indent === jobsIndent + 2 && /^[A-Za-z0-9_-]+:$/.test(stripped)) {
      job = stripped.slice(0, -1);
      jobIndent = indent;
      collecting = false;
      if (!result.has(job)) result.set(job, []);
      continue;
    }
    if (!job) continue;
    if (indent === jobIndent + 2 && stripped === "env:") {
      collecting = true;
      envIndent = indent;
      continue;
    }
    if (indent === jobIndent + 2 && stripped.startsWith("env:")) {
      collecting = false;
      const value = stripped.slice("env:".length).trim();
      if (value) result.get(job)!.push(value);
      continue;
    }
    if (collecting && indent > envIndent) result.get(job)!.push(stripped);
    else if (collecting) collecting = false;
  }
  return result;
}

function expressions(line: string): string[] {
  return [...line.matchAll(/\$\{\{([\s\S]*?)\}\}/g)].map((match) => match[1]);
}

function referencesRunner(expression: string): boolean {
  return /(^|[^A-Za-z0-9_])runner\b/.test(expression);
}

function signingSecret(expression: string, os: string): string {
  const match = expression.match(
    /^matrix\.os == '([^']+)' && secrets\.([A-Z0-9_]+) \|\| secrets\.([A-Z0-9_]+)$/,
  );
  assert.ok(match, expression);
  assert.equal(match[1], "windows-latest");
  return os === "windows-latest" ? match[2] : match[3];
}

const historicalJobEnv = `
jobs:
  desktop:
    env:
      CSC_LINK: \${{ runner.os == 'Windows' && secrets.WINDOWS_CSC_LINK || secrets.MAC_CSC_LINK }}
      COMPOSITOR_ANDROID_KEYSTORE: \${{ runner.temp }}/compositor.jks
    steps:
      - if: runner.os == 'Windows'
        run: echo "COMPOSITOR_ANDROID_KEYSTORE=\${{ runner.temp }}/compositor.jks" >> "$GITHUB_ENV"
`;

test("job-level env cannot read runner, including the expressions GitHub rejected", () => {
  const env = jobLevelEnv(historicalJobEnv);
  const lines = env.get("desktop") ?? [];
  assert.equal(lines.length, 2);
  assert.ok(lines.every((line) => expressions(line).some(referencesRunner)));
  const stepOnly = historicalJobEnv.replace(
    /    env:[\s\S]*?    steps:/,
    "    steps:",
  );
  const stepEnv = [...jobLevelEnv(stepOnly).values()].flat();
  assert.equal(stepEnv.length, 0);
  assert.match(stepOnly, /\$\{\{ runner\.temp \}\}/);
});

test("checked-in workflows keep runner off job env and keep signed release fail-closed", async () => {
  const names = (await readdir(workflowsDir)).filter((name) => name.endsWith(".yml"));
  assert.deepEqual(names.sort(), ["page-contract.yml", "platforms.yml", "release.yml", "windows.yml"]);
  for (const name of names) {
    const text = await readFile(new URL(name, workflowsDir), "utf8");
    for (const [job, lines] of jobLevelEnv(text)) {
      for (const line of lines) {
        for (const expression of expressions(line)) {
          assert.equal(
            referencesRunner(expression),
            false,
            `${name} job ${job} env uses runner: ${line}`,
          );
        }
      }
    }
  }

  const release = await readFile(new URL("release.yml", workflowsDir), "utf8");
  const jobs = jobLevelEnv(release);
  const desktop = jobs.get("desktop") ?? [];
  const link = desktop.find((line) => line.startsWith("CSC_LINK:"));
  const password = desktop.find((line) => line.startsWith("CSC_KEY_PASSWORD:"));
  assert.ok(link && password);
  const linkExpr = expressions(link)[0].trim();
  const passwordExpr = expressions(password)[0].trim();
  assert.equal(signingSecret(linkExpr, "windows-latest"), "WINDOWS_CSC_LINK");
  assert.equal(signingSecret(linkExpr, "macos-latest"), "MAC_CSC_LINK");
  assert.equal(signingSecret(linkExpr, "ubuntu-latest"), "MAC_CSC_LINK");
  assert.equal(signingSecret(passwordExpr, "windows-latest"), "WINDOWS_CSC_PASSWORD");
  assert.equal(signingSecret(passwordExpr, "macos-latest"), "MAC_CSC_PASSWORD");
  assert.match(release, /if: runner\.os != 'Linux'\r?\n\s+run:.*Signing credentials required/);
  assert.match(release, /dist:win -- --publish never --config\.forceCodeSigning=true/);
  assert.match(release, /dist:mac -- --publish never --config\.forceCodeSigning=true/);

  const android = (jobs.get("android") ?? []).join("\n");
  assert.doesNotMatch(android, /COMPOSITOR_ANDROID_KEYSTORE|runner/);
  assert.match(android, /ANDROID_STORE_PASSWORD/);
  assert.match(android, /ANDROID_KEY_ALIAS/);
  assert.match(android, /ANDROID_KEY_PASSWORD/);
  const keystorePath = release.indexOf(
    'COMPOSITOR_ANDROID_KEYSTORE=${{ runner.temp }}/compositor.jks" >> "$GITHUB_ENV"',
  );
  const keystoreWrite = release.indexOf(
    "fs.writeFileSync(process.env.COMPOSITOR_ANDROID_KEYSTORE",
  );
  assert.ok(keystorePath > 0 && keystoreWrite > keystorePath);
  assert.match(release, /Android signing credentials required/);
  assert.match(release, /IOS_CERT_BASE64: \$\{\{ secrets\.IOS_CERT_BASE64 \}\}/);
  assert.match(release, /node scripts\/build-ios-release\.mjs/);
  assert.match(release, /release-manifest\.mjs --signed/);
  assert.match(release, /gh release create "\$RELEASE_TAG" release\/\* --draft --verify-tag/);
});
