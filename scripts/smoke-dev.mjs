import { createServer } from "vite";
import { _electron } from "@playwright/test";
import assert from "node:assert/strict";

const server = await createServer();
await server.listen();
let app;
try {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key, value]) => key !== "ELECTRON_RUN_AS_NODE" && value !== undefined,
    ),
  );
  Object.assign(env, {
    COMPOSITOR_DEV_URL: "http://127.0.0.1:5173",
    APP_ENV: "dev",
    COMPOSITOR_TEST: "1",
  });
  app = await _electron.launch({ args: ["."], env, timeout: 30_000 });
  const page = await app.firstWindow();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") console.error(message.text());
  });
  await page
    .getByRole("heading", { name: "BGSSAI Compositor" })
    .waitFor({ timeout: 15_000 });
  assert.equal(
    (await page.evaluate(() => window.desktop.getInfo())).channel,
    "development",
  );
  assert.deepEqual(errors, []);
  console.log("Development app passed: Vite, React and dev properties.");
} finally {
  if (app) {
    await app.evaluate(({ app }) => app.exit(0)).catch(() => {});
    await app.close().catch(() => {});
  }
  await server.close();
}
