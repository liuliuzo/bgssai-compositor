# Desktop packaging regression check — 2026-10-15

PR #5 run 38708185459 failed macOS packaging because the fallback application icon was 256×256 (minimum 512×512), and Linux deb packaging because author email was absent. The develop baseline run 38682801581 fails with the same two errors; neither was introduced by model receipts.

Preserve the existing vector mark and Windows ICO. Generate the PNG at 1024×1024 using the existing deterministic renderer, select it explicitly for macOS, and reuse the BGSSAI maintainer identity already configured in the Bot desktop package. No signing, notarization, publishing or deployment bypass is added.

Local validation: all 18 Node tests pass; TypeScript and Vite build pass. The installed electron-builder icon converter successfully produces a 1024px ICNS (138817 bytes) from the generated PNG, and package metadata includes a maintainer email. git diff --check passes. macOS and Linux complete installers still require the updated platform CI run; no local cross-platform installer success is claimed.

At head 48e8b13, run 38710950328 successfully builds macOS, Linux, Android and iOS. Windows run 38710950299 failed before packaging in its editor E2E suite: attempt 1 waited for the New dialog; attempt 2 passed that test but waited for the artboard after Open. Both finished 9/10 E2E tests, with all 18 Node tests and TypeScript/Vite passing. The failures are consistent with the startup readiness race reproduced below; neither run reached icon packaging.

The action guard already rejected document operations before recovery initialization or while an old snapshot needs a user decision, but the corresponding buttons were enabled. Make their disabled state match that guard, and expose pending initialization through aria-busy. A deterministic Electron regression holds the real recovery:read IPC unresolved and verifies New/Open/Create/Open Project/Demo are disabled, then releases it and creates the dialog. Before this fix the new test fails because New remains enabled. No retry or timeout increase is introduced.

After the readiness fix, local `npm run check` passes: 18 Node tests, TypeScript/Vite build, and all 11 real Electron E2E tests (including delayed recovery, selection/crop, software filters, forced process exit/restart and mobile layout). Final installer and platform status is tracked on PR #5; production credentials and signed distribution remain outside this local validation.
