# Desktop packaging regression check — 2026-10-15

PR #5 run 38708185459 failed macOS packaging because the fallback application icon was 256×256 (minimum 512×512), and Linux deb packaging because author email was absent. The develop baseline run 38682801581 fails with the same two errors; neither was introduced by model receipts.

Preserve the existing vector mark and Windows ICO. Generate the PNG at 1024×1024 using the existing deterministic renderer, select it explicitly for macOS, and reuse the BGSSAI maintainer identity already configured in the Bot desktop package. No signing, notarization, publishing or deployment bypass is added.

Local validation: all 18 Node tests pass; TypeScript and Vite build pass. The installed electron-builder icon converter successfully produces a 1024px ICNS (138817 bytes) from the generated PNG, and package metadata includes a maintainer email. git diff --check passes. macOS and Linux complete installers still require the updated platform CI run; no local cross-platform installer success is claimed.
