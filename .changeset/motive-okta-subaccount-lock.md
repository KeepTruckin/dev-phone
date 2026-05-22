---
"@motive/plugin-dev-phone": minor
"@motive/dev-phone-ui": minor
---

Motive integration:

- Lock the plugin to the Motive Motive testing Twilio subaccount. The plugin exits with a clear error if the active Twilio CLI profile points elsewhere. Override with `MOTIVE_DEV_PHONE_SUBACCOUNT_SID` for regional rollouts.
- Stamp every dev-phone resource (API key, TwiML app, Sync service, Conversation, serverless functions) with the caller's Okta email so Twilio Console activity is attributable. Identity is supplied by `mtv dev-phone` via `MOTIVE_OKTA_EMAIL` or `~/.config/motive/dev-phone.env`.
- Add an `ownership` field to `/phone-numbers` responses. The UI dropdown now labels each number as `free`, `external webhook`, `yours`, or `taken by <email>`, and disables numbers actively in use by another engineer's running dev-phone.
- `/choose-phone-number` returns HTTP 409 if a caller tries to pick a number owned by someone else, guarding the API in addition to the UI.
- Include `currentUserEmail` and `subaccountSid` in `/plugin-settings` so the UI can render ownership info.
