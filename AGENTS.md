# AGENTS

BGSSAI Compositor is a **desktop-only** image editor. The product vision (2026-10-28) is a PS-like compositor for **Windows PC**. There is **no web deploy**.

Read [PRODUCT_VISION.md](PRODUCT_VISION.md) before changing product scope. [README.md](README.md) must stay consistent with this file.

## Platform

- The product is the Windows desktop app: `electron/`, x64 NSIS and portable, Windows 10 / Windows 11.
- Do not add a browser edition, hosted editor, static-site release, or any other web deployment of the compositor.
- `npm run service` is an optional local API for account, sync, Bot, and TokenHub. It is not a web app.
- iOS (`clients/ios`) and Android (`clients/android`) are **non-goals**. They are experimental trees, not the product vision. Do not extend them, and do not describe simulator builds, debug APKs, or Capacitor directories as delivery. Do not mass-delete those trees unless the task explicitly requires removal.
- macOS and Linux Electron scripts may remain in the repo. They are not the product vision. Do not present them as committed platforms.
- Older notes under `docs/` may still say “五端” or list iOS/Android as future delivery. Those snapshots do not override this file or `PRODUCT_VISION.md`.

## Working rules

- Keep user-facing product statements desktop-only, with Windows as the primary platform, and with mobile marked experimental / not vision.
- Do not commit secrets, credentials, signing material, or environment keys.
- Do not merge pull requests unless the task says to merge.
