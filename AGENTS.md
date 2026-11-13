# AGENTS

BGSSAI Compositor (`bgssai-compositor`) is a **client-only, non-web** Photoshop-class layer and canvas image editor referencing `robbietilton/Compositor`. Under the **2026-11-13** product-line calibration:

- **Primary delivery**: Windows PC desktop app (`electron/`, Windows 10 / Windows 11 x64 NSIS installer and portable executable).
- **No web deployment**: There is strictly **no web-server editor deployment** (`没有 Web 端部署`). Do not deploy or describe the editor as a public web app.
- **5-platform client matrix**: Along with the other 30 non-support BGSSAI products (`31 x 5 = 155`), `bgssai-compositor` participates in the `Windows / macOS / Linux / iOS / Android` client matrix (`electron/` for desktop targets and `clients/ios`, `clients/android` for mobile client targets), while keeping Windows PC desktop as the primary committed desktop build.

Read [PRODUCT_VISION.md](PRODUCT_VISION.md) before changing product scope. [README.md](README.md) and [CLAUDE.md](CLAUDE.md) (`@AGENTS.md`) must stay consistent with this file.

## Architecture and Redlines

- **Offline-first desktop engine**: Local `.bgcomp` editing, autosave recovery, import, and export work completely offline without login.
- **Optional local/companion service (`service/server.mjs`)**: Handles `https://chat.bgssai.cn` user-side OAuth 2.0 / PKCE binding, central `bgssai_chat` quota check/report, project sync, `bgssai-bot` / MCP operations, and `/api/download/bot` metadata. It is not a web deployment of the editor.
- **Same-region CN model routing & UI brand masking**: Backend AI calls route strictly within Mainland China (`cn`) with zero cross-region fallback. Never expose `TokenHub` or `bgssai-tokenhub-cn` in user-facing UI or error messages; expose `0.5x / 1x / 1.5x` multiplier rules instead (default `bgssai-chat` at `0.5x`) and compact `K / M / B` token displays with exact integer hover/API values.
- **In-app Bot entry & embedded shell**: Support in-app `/download/bot` view (`https://chat.bgssai.cn` packages) and `bgssai_shell=1` embedded host shell layout.
- **Zero emoji & secret hygiene**: Never introduce emoji characters anywhere in code, docs, or commit messages. Never commit secrets, signing keys, or runtime credentials.
