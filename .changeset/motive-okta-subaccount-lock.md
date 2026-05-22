---
"@motive/plugin-dev-phone": minor
"@motive/dev-phone-ui": minor
---

Motive integration:

- Lock the plugin to the Motive testing Twilio subaccount. The plugin exits with a clear error if the active Twilio CLI profile points elsewhere. Override with `MOTIVE_DEV_PHONE_SUBACCOUNT_SID` for regional rollouts.
- Stamp every dev-phone resource (API key, TwiML app, Sync service, Conversation, serverless functions) with the caller's full Okta email slug so Twilio Console activity is attributable and resource names don't collide between engineers with the same local-part. Identity is supplied by `mtv dev-phone` via `MOTIVE_OKTA_EMAIL` or `~/.config/motive/dev-phone.env`.
- Add an `ownership` field to `/phone-numbers` responses. The UI dropdown now labels each number as `free`, `external webhook`, `yours`, or `taken by <email>`, and disables numbers actively in use by another engineer's running dev-phone. The ownership classifier strips Twilio's serverless deployment suffix so the URL-derived slug matches the caller's slug.
- `/choose-phone-number` returns HTTP 409 if a caller tries to pick a number owned by someone else, guarding the API in addition to the UI.
- Include `currentUserEmail` and `subaccountSid` in `/plugin-settings` so the UI can render ownership info.
- Twilio API keys are never persisted to disk. In the mtv-managed path the key lives in the OS keychain via the Twilio CLI profile; in the env-var fallback path a per-run key is created on startup and removed on shutdown. API-key creation failures now throw `TwilioCliError` instead of being silently swallowed.
- Print Motive support links (Slack `#eng-customer-platform-support`, Confluence runbook) on startup and on every fatal-error path.
