# Central Quota Ledger and Same-Region TokenHub Contract (Plan A)

## 1. Architecture Overview

Under Plan A, **bgssai-compositor** (CN) aligns with the BGSSAI central identity and model hub architecture:

1. **Central Identity and Quota Ledger in `bgssai-chat-cn` (`bgssai_chat`)**:
   - `bgssai-chat-cn` (`bgssai_chat`) and `bgssai-chat-global` (`bgssai_chat_global`) use the company self-hosted LLM (`bgssai-chat`) directly (not via TokenHub) and hold the central user account (OAuth 2.0 / OIDC third-party login, user-side only) and central subscription/token quota ledger.
   - Online AI operations in `bgssai-compositor` require the user to bind or sign in with `bgssai-chat-cn` before calling LLMs, and settle token quota against the central `bgssai_chat` ledger (`bgssai_chat.user_quota`, `bgssai_chat.usage_ledger`, `bgssai_chat.usage_idempotency`).
2. **Same-Region Model Routing (`bgssai-tokenhub-cn`)**:
   - All AI text/image calls in `bgssai-compositor` route strictly through `bgssai-tokenhub-cn` (`https://www.bgssai-tokenhub.cn`) with zero cross-region fallback.
   - End-user UI hides `bgssai-tokenhub` branding, hostnames, and upstream keys.
3. **Default Self-Hosted Model (`bgssai-chat` at `0.5x`) and 3-Tier Multipliers**:
   - Default model: `bgssai-chat` (company self-hosted LLM) at `0.5x` token consumption multiplier.
   - Model picker displays `0.5x / 1x / 1.5x` token consumption multipliers and compact `K / M / B` token balances (with exact integer hover and API payloads).
