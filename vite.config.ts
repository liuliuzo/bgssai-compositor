import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { readFileSync } from "node:fs";
const environment = process.env.APP_ENV === "dev" ? "dev" : "prod";
const properties = Object.fromEntries(
  readFileSync(`config/application-${environment}.properties`, "utf8")
    .split(/\r?\n/)
    .filter((line) => line && !line.startsWith("#"))
    .map((line) => {
      const i = line.indexOf("=");
      return [line.slice(0, i), line.slice(i + 1)];
    }),
);
const clientConfig = Object.fromEntries(
  [
    "ecosystem.url",
    "chat.issuer",
    "support.url",
    "downloads.url",
    "bot.url",
  ].map((key) => [key, properties[key] ?? ""]),
);
const connectOrigin = clientConfig["ecosystem.url"]
  ? new URL(clientConfig["ecosystem.url"]).origin
  : "";
if (connectOrigin && !connectOrigin.startsWith("https://"))
  throw new Error("在线服务必须使用 HTTPS");

export default defineConfig({
  base: "./",
  plugins: [
    react(),
    {
      name: "service-csp",
      transformIndexHtml(html) {
        return html.replace(
          "connect-src 'self' ws://127.0.0.1:5173",
          `connect-src 'self' ws://127.0.0.1:5173 ${connectOrigin}`,
        );
      },
    },
  ],
  define: { __APP_CONFIG__: JSON.stringify(clientConfig) },
  server: { host: "127.0.0.1", port: 5173, strictPort: true },
  build: { target: ["chrome140", "safari17"] },
});
