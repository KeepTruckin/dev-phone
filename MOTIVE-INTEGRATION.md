# Motive dev-phone integration plan

> **Status:** Draft for review. Nothing in this document has been executed yet.
>
> **Author:** andre.santos@gomotive.com
> **Date:** 2026-05-21

## Description

`twilio-labs/dev-phone` is an open-source Twilio CLI plugin that lets a developer pick a Twilio phone number, start a local Express server, and use a browser UI as a "developer phone" for testing SMS and voice flows against real Twilio. Today the plugin:

- Reads credentials from whatever Twilio CLI profile (or `TWILIO_ACCOUNT_SID` / `TWILIO_AUTH_TOKEN` env vars) the engineer has configured locally.
- Has no concept of identity beyond a random `dev-phone-1234` name.
- Has no concept of subaccount scoping.

For Motive, we need three things:

1. **Identity-aware access.** Only Motive engineers who have authenticated through Okta should be able to use the tool, and every Twilio resource the plugin creates should be tagged with the engineer's email so we can audit who did what.
2. **Subaccount lockdown.** The plugin should only operate against Motive testing Twilio subaccount. No path to the master account or any other subaccount.
3. **No accidental collisions.** With a shared subaccount, multiple engineers can target the same phone number. The UI should clearly show which numbers are already taken by a teammate's running dev-phone and prevent picking them.

The setup target is **one command** — `mtv dev-phone` — that an engineer runs after their normal Okta-backed AWS auth. It handles the full chain: install the Twilio CLI and Motive's plugin fork if missing, fetch the subaccount-scoped Twilio API key from AWS SSM Parameter Store, write a dedicated Twilio CLI profile, stamp the run with the engineer's Okta email, and finally launch the plugin. Every step is idempotent, so re-running is fast.

The work splits across two repos:

| Repo | Role |
|------|------|
| `KeepTruckin/dev-phone` *(new fork of `twilio-labs/dev-phone`)* | Plugin changes: subaccount guard, Okta-stamped naming, phone-number ownership/taken indicator. |
| `KeepTruckin/local-dev` *(existing `mtv` CLI repo)* | New `mtv dev-phone` subcommand that wraps the above. Installs Twilio CLI + plugin lazily on first run — *not* in bootstrap. |

Twilio side, the only one-time setup is creating a Standard API Key scoped to the subaccount and seeding the API key SID + secret into AWS SSM Parameter Store. Twilio API Keys are already scoped to the (sub)account that owns them, so there is no SSO or federation work to do on Twilio's side.

---

## Goals

1. Lock the plugin to the Motive testing subaccount with a hard guard in code.
2. Distribute Twilio credentials only to engineers authenticated through Okta, via AWS SSM Parameter Store + IAM.
3. Stamp every dev-phone run with the engineer's Okta email so Twilio Console resources are attributable.
4. Surface phone-number ownership in the UI; block selection of numbers already taken by another engineer's running dev-phone.
5. One-command experience: `mtv dev-phone` does everything.

## Non-goals

- Per-user Twilio API keys (we use a shared subaccount-scoped key).
- Ephemeral / per-run Twilio API keys.
- Twilio Console SSO / SAML federation.
- Publishing the plugin to a private npm registry. We install from a git URL.
- Terraforming the Twilio API key + AWS secret. Manual seeding now; Terraform is a flagged follow-up.

---

## High-level architecture

```
┌────────────────────────────┐
│ Engineer terminal          │
│                            │
│  mtv dev-phone             │
│         │                  │
│         ▼                  │
│  1. ensure_twilio_installed│
│  2. mtv aws auth (Okta)    │──► Okta ──► AWS STS (temp creds)
│  3. AWS SSM Param Store    │──► get /dev-phone/prvw/use1/core/api-{key-sid,secret}
│  4. twilio profiles:create │     (writes to OS keychain)
│  5. exec twilio dev-phone  │
└──────────┬─────────────────┘
           │
           ▼
┌────────────────────────────┐         ┌──────────────────────┐
│ dev-phone plugin (forked)  │         │ Twilio subaccount    │
│  - subaccount guard        │◄────────│ (SID from SSM)       │
│  - Okta email naming       │  API    │  - API Key (shared)  │
│  - /phone-numbers w/ owner │         │  - resources tagged  │
│  - /choose-phone-number 409│         │    dev-phone-<email> │
└──────────┬─────────────────┘         └──────────────────────┘
           │ HTTP
           ▼
┌────────────────────────────┐
│ dev-phone-ui (React)       │
│  - badge: free/taken/ext   │
│  - disabled options for    │
│    "taken by <other dev>"  │
└────────────────────────────┘
```

---

## One-time setup

### Fork the repo

`KeepTruckin/dev-phone` does not exist yet. The current local clone still points at `twilio-labs/dev-phone`. Steps:

1. Fork `twilio-labs/dev-phone` to the `KeepTruckin` org. (`gh repo fork` from a token without org admin perms fails with HTTP 403; either fork via the GitHub UI or run from an account with org-repo-creation rights.)
2. In the local clone: `git remote rename origin upstream && git remote add origin git@github.com:KeepTruckin/dev-phone.git`.
3. Push `main` to the new origin.

We track upstream via the `upstream` remote and pull in fixes by periodic merge or cherry-pick.

### Rename packages

The current packages are `@twilio-labs/plugin-dev-phone` and `@twilio-labs/dev-phone-ui`. Rename:

- `packages/plugin-dev-phone/package.json` → `@motive/plugin-dev-phone`, version `1.0.0-motive.1`. Update `repository.url`, `homepage`, `bugs.url` to point at `KeepTruckin/dev-phone`.
- `packages/dev-phone-ui/package.json` → `@motive/dev-phone-ui`.
- `packages/plugin-dev-phone/package.json` dependency on `@twilio-labs/dev-phone-ui` → `@motive/dev-phone-ui` (same version).

The `1.0.0-motive.*` suffix makes it visually clear in `twilio plugins` output that the engineer is running the Motive fork.

### Twilio

In the Twilio Console, signed in as the master account:

1. Switch into the Motive testing subaccount.
2. Create a **Standard API Key**, friendly name `motive-dev-phone-shared`. Save the `SK...` SID and secret (shown once).

### AWS SSM Parameter Store

Per the Motive [Secrets Management via CLI guide](https://k2labs.atlassian.net/wiki/spaces/ENG/pages/3726180619/Secrets+Management+via+CLI), credentials live in SSM Parameter Store (default backend) — *not* Secrets Manager. Each parameter holds one value, following the `/service/environment/region/component/secret` naming convention.

Three parameters, all in `mtv-nonproduction` / `us-east-1`:

| Parameter path                              | Value                                                |
| ------------------------------------------- | ---------------------------------------------------- |
| `/dev-phone/prvw/use1/core/account-sid`     | `AC…` (the subaccount SID from the Twilio Console)   |
| `/dev-phone/prvw/use1/core/api-key-sid`     | `SK…` (the API key SID from the Twilio Console)      |
| `/dev-phone/prvw/use1/core/api-secret`      | The API key secret (shown only once at creation)     |

Seed them with `mtv secret`:

```bash
mtv aws auth keeptruckin 720640205712               # mtv-nonproduction
mtv secret create us-east-1 prvw dev-phone core account-sid
mtv secret create us-east-1 prvw dev-phone core api-key-sid
mtv secret create us-east-1 prvw dev-phone core api-secret
```

The subaccount SID is *not* hardcoded anywhere — GitHub's secret scanner flags Twilio Account SIDs and would refuse the push. The SID is stored as the third SSM parameter and fetched at runtime alongside the API key + secret.

KMS / IAM policy is inherited from the standard `mtv secret` setup; no extra resource policy is needed. To target a region other than `us-east-1`, override `TWILIO_API_KEY_PARAM`, `TWILIO_API_SECRET_PARAM`, and `TWILIO_SECRET_AWS_REGION` (the parameter region segment must match: `use1` → `us-east-1`, `euc1` → `eu-central-1`).

### Distribution

Twilio CLI plugins are oclif plugins. `twilio plugins:install` accepts either an npm package name or a git URL. For v1 we use the git URL — no npm publishing infra, no `.npmrc` auth, no GitHub Packages token to rotate:

```
twilio plugins:install git+https://github.com/KeepTruckin/dev-phone.git#main
```

oclif clones the repo, runs `npm install` + `npm run build`, and registers the plugin. Pinning to `#main` means we can push updates to `main` and engineers pick them up with `twilio plugins:update`.

Cons noted for the follow-up list: cold install is ~30s (vs ~5s npm), and there's no semver pinning. If the plugin churns, move to GitHub Packages (`@motive` scope in `npm.pkg.github.com`) and reuse the GitHub token `mtv github` already writes to `~/.github/credentials`. Out of scope for this PR.

---

## Changes — `KeepTruckin/dev-phone` (plugin)

### 1. Identity helper

New file `packages/plugin-dev-phone/src/utils/identity.ts`:

- `getCallerEmail()` — reads `process.env.MOTIVE_OKTA_EMAIL` first; falls back to parsing `~/.config/motive/dev-phone.env` (a `KEY=value` file written by `mtv dev-phone`). Returns `null` on miss.
- `slugEmail(email)` — `alice@gomotive.com` → `alice-at-gomotive-com` (lowercased, only `[a-z0-9-]`). Used in resource names.
- `unslugEmail(slug)` — inverse, used when parsing a webhook URL back to an owner.

### 2. Subaccount guard + Okta-stamped naming

In `packages/plugin-dev-phone/src/commands/dev-phone.ts`:

- At the top of `async run()` (currently [dev-phone.ts:58](packages/plugin-dev-phone/src/commands/dev-phone.ts:58)), before any Twilio API call:
  ```ts
  // Always sourced from env (set by `mtv dev-phone` from SSM); no default.
  const EXPECTED_SUBACCOUNT_SID = process.env.MOTIVE_DEV_PHONE_SUBACCOUNT_SID || '';

  if (!EXPECTED_SUBACCOUNT_SID) {
    this.logger.error('MOTIVE_DEV_PHONE_SUBACCOUNT_SID not set. Run: mtv dev-phone');
    process.exit(1);
  }
  if (this.twilioClient.accountSid !== EXPECTED_SUBACCOUNT_SID) {
    this.logger.error(
      `dev-phone is locked to subaccount ${EXPECTED_SUBACCOUNT_SID}. ` +
      `Current profile points at ${this.twilioClient.accountSid}. ` +
      `Run: mtv dev-phone`,
    );
    process.exit(1);
  }

  const callerEmail = getCallerEmail();
  if (!callerEmail) {
    this.logger.error(
      'No Motive Okta identity found. Run: mtv dev-phone',
    );
    process.exit(1);
  }
  ```
- Replace the random-name generator at [dev-phone.ts:52](packages/plugin-dev-phone/src/commands/dev-phone.ts:52) so `this.devPhoneName = \`dev-phone-${slugEmail(callerEmail)}-${shortRandom(4)}\``. The short random suffix keeps multiple sessions from the same engineer distinguishable. The Okta email then propagates automatically into TwiML app, Sync service, Conversation, API key, and serverless function friendly names (they all already use `this.devPhoneName`).
- The env override exists so we can target a different subaccount in EU/regional rollouts without a code change, satisfying the multi-region constraint.

### 3. Phone-number ownership

In `packages/plugin-dev-phone/src/commands/dev-phone.ts`, extend `reformatTwilioPns` (currently [dev-phone.ts:30](packages/plugin-dev-phone/src/commands/dev-phone.ts:30)) to compute and include an `ownership` field per number:

```ts
const OWNER_RE = /https?:\/\/dev-phone-([a-z0-9-]+?)-[a-z0-9]{4,}\./i;

const ownershipFor = (pn: { voiceUrl?: string; smsUrl?: string }) => {
  const url = pn.voiceUrl || pn.smsUrl || '';
  if (!url) return { state: 'free' as const };
  const m = url.match(OWNER_RE);
  if (m) return { state: 'taken' as const, owner: unslugEmail(m[1]) };
  if (/https?:\/\/dev-phone-/.test(url)) return { state: 'taken' as const };
  return { state: 'taken-external' as const };
};
```

Three states:

- `free` — no webhook configured (or no SMS/voice URL).
- `taken` — webhook URL matches the dev-phone pattern. `owner` is parsed from the URL when possible; otherwise just `taken` with no owner (covers numbers configured by the older upstream plugin before the rename).
- `taken-external` — has a webhook URL, but it's not a dev-phone URL. Treated as "someone's personal stuff" and overwritable with the existing warning.

### 4. Server-side guard in `/choose-phone-number`

In the `app.all('/choose-phone-number', ...)` handler ([dev-phone.ts:190](packages/plugin-dev-phone/src/commands/dev-phone.ts:190)), after looking up the selected number:

```ts
const ownership = ownershipFor(selectedNumber[0]);
if (ownership.state === 'taken' && ownership.owner && ownership.owner !== callerEmail) {
  return res.status(409).json({
    error: 'in_use_by',
    owner: ownership.owner,
    message: `In use by ${ownership.owner}. Pick a different number.`,
  });
}
```

Belt-and-braces against a stale UI: even if a user crafts the request directly, the server refuses. Same-owner case (the engineer reconnecting to a number they previously had) is allowed.

### 5. UI badge + disabled options

In `packages/dev-phone-ui/src/components/PhoneNumberPicker/PhoneNumberPicker.jsx`:

- Render a Paste `Badge` next to each Option in the dropdown:
  - **green** `free`
  - **yellow** `taken-external` (existing warning behavior preserved — overwritable on confirm)
  - **red** `taken by alice@gomotive.com` (or just `taken` if no owner could be parsed)
- Options whose `ownership.state === 'taken'` and `owner !== currentUser` are rendered with `disabled` and a hover-tooltip saying "In use by `<owner>` — pick a different number". Paste's `Option` supports `disabled` directly.
- The current `hasExistingConfig` Alert stays for the `taken-external` case.
- Sort order: `free` first, then `taken-external`, then disabled `taken`. Tweak the existing `sortUnconfiguredNumbersFirstThenAlphabetically`.

New file `packages/dev-phone-ui/src/utils/ownership.js` for display helpers (`badgeVariantFor`, `badgeTextFor`), exported so they're testable.

Current-user discovery in the UI: extend the existing `/plugin-settings` endpoint ([dev-phone.ts:151](packages/plugin-dev-phone/src/commands/dev-phone.ts:151)) to include `currentUserEmail: callerEmail`. The UI already fetches this on mount.

### 6. Tests

- `packages/plugin-dev-phone/test/utils/identity.test.ts` — env-var priority, file fallback, both-missing case, slug/unslug roundtrip.
- `packages/plugin-dev-phone/test/utils/ownership.test.ts` — `free`, `taken-external`, `taken` with owner, `taken` without owner.
- `packages/dev-phone-ui/src/utils/ownership.test.js` — display helpers.

The existing `reuseOrCreateApiKey()` path doesn't have tests today; we'll add a small one for the guard in the same PR per Motive's "new behavior gets coverage" rule.

### 7. Docs

- Update root [README.md](README.md): install line becomes `mtv dev-phone` (Motive flow). Add fallback `twilio plugins:install git+https://github.com/KeepTruckin/dev-phone.git#main` for engineers not using mtv. Mention the Okta + subaccount lock.
- Update [DEVELOPMENT.md](DEVELOPMENT.md) with how to run locally with a different subaccount (`MOTIVE_DEV_PHONE_SUBACCOUNT_SID` + a custom Twilio CLI profile).
- Add a `.changeset/` entry summarizing the changes.

---

## Changes — `KeepTruckin/local-dev`

### `lib/mtv/twilio.sh` *(new)*

Primary command: `mtv dev-phone [-- <args passed to twilio dev-phone>]`.

Step-by-step:

1. **Ensure Twilio CLI + plugin installed** (`ensure_twilio_installed`):
   - `command -v twilio` → if missing, `brew install twilio/brew/twilio` on macOS, `npm i -g twilio-cli` fallback.
   - `twilio plugins | grep -q '@motive/plugin-dev-phone'` → if missing, `twilio plugins:install git+https://github.com/KeepTruckin/dev-phone.git#main`.
   - Idempotent. **No bootstrap install** — engineers who never use the dev-phone never pay for the install. Also exposed as `mtv dev-phone install` for engineers who want to prefetch.
2. **Ensure Okta/STS creds.** `aws sts get-caller-identity --profile <dev-tools-profile>` → on failure or expiry, call `mtv aws auth` (interactive Okta browser flow). No-op if creds are fresh.
3. **Fetch Twilio creds.** Three `aws ssm get-parameter --with-decryption` calls — `/dev-phone/prvw/use1/core/account-sid`, `…/api-key-sid`, `…/api-secret`. Sanity-checked prefixes (`AC…`, `SK…`).
4. **Resolve Okta email.** Parse the role-session-name from `aws sts get-caller-identity` (set to the Okta user by `okta-aws-cli`). Cache to `~/.config/motive/dev-phone.env` (mode 0600) alongside the resolved subaccount SID.
5. **Write/refresh Twilio CLI profile.** Profile name `dev-phone`, account SID + API key from SSM. The CLI keeps the secret in the OS keychain — no plaintext on disk. The profile is removed and recreated each run so rotated SSM values land immediately.
6. **Exec the plugin.** `MOTIVE_OKTA_EMAIL=$email MOTIVE_DEV_PHONE_SUBACCOUNT_SID=$sid TWILIO_ACTIVE_PROFILE=dev-phone exec twilio dev-phone "$@"`. Flags after `--` pass straight through. `TWILIO_ACTIVE_PROFILE` (the Twilio CLI's documented env var) avoids mutating the user's global active profile.

Helper subcommands (small, for debugging / `#help-devtools` triage):

- `mtv dev-phone logout` — `twilio profiles:remove dev-phone` and delete `~/.config/motive/dev-phone.env`.
- `mtv dev-phone status` — print active profile, account SID, Okta email, secret last-rotated time.

### Dispatcher

`bin/mtv` auto-dispatches subcommands by filename (the file's name with `_` replaced by `-`), so dropping in `lib/mtv/dev_phone.sh` and making it executable wires `mtv dev-phone` up. Add a one-line entry to the `usage()` block in `bin/mtv`.

### Bootstrap

The Twilio CLI install is **opt-in, not part of bootstrap**. Engineers who never need the dev-phone never pay the install cost. The first `mtv dev-phone` run installs the CLI + plugin on demand; engineers who want to prefetch can run `mtv dev-phone install` explicitly.

### Docs

Short section in the `local-dev` README: "Using dev-phone → `mtv dev-phone`". That single line is the whole onboarding path; everything else (Okta auth, profile creation, secret fetch, plugin install) happens automatically on first run.

---

## Critical files

### `KeepTruckin/dev-phone`

- `packages/plugin-dev-phone/package.json` — rename to `@motive/plugin-dev-phone`, bump version
- `packages/dev-phone-ui/package.json` — rename to `@motive/dev-phone-ui`
- `packages/plugin-dev-phone/src/commands/dev-phone.ts` — subaccount guard, Okta-stamped `devPhoneName`, `ownership` field, server-side guard in `/choose-phone-number`, `currentUserEmail` in `/plugin-settings`
- `packages/plugin-dev-phone/src/utils/identity.ts` *(new)*
- `packages/plugin-dev-phone/test/utils/identity.test.ts` *(new)*
- `packages/plugin-dev-phone/test/utils/ownership.test.ts` *(new)*
- `packages/dev-phone-ui/src/components/PhoneNumberPicker/PhoneNumberPicker.jsx` — badge + disabled options
- `packages/dev-phone-ui/src/utils/ownership.js` *(new)*
- `packages/dev-phone-ui/src/utils/ownership.test.js` *(new)*
- `README.md`, `DEVELOPMENT.md`, `.changeset/*.md` — docs

### `KeepTruckin/local-dev`

- `lib/mtv/dev_phone.sh` *(new)* — subcommand + `ensure_twilio_installed` helper
- `bin/mtv` — usage entry
- `lib/mtv/manifest.txt` — entry for `dev_phone.sh`
- `README.md` — onboarding doc

---

## Verification

### End-to-end happy path (cold cache: no Twilio CLI, no Okta session, no profile)

1. Fresh shell on a freshly bootstrapped machine. Run `mtv dev-phone`.
2. Step 1 detects no `twilio` binary (or no plugin), installs both via `brew` (macOS) or `npm i -g` + `twilio plugins:install git+…#main`. Bootstrap does *not* preinstall — this is the first time we touch Twilio tooling.
3. Step 2 detects no STS creds, opens Okta in the browser; user signs in, returns.
4. Command continues silently: secret fetched, Twilio profile `dev-phone` created, env file written.
5. `twilio dev-phone` boots in the same invocation. Console logs include the Okta email. Twilio Console shows new resources prefixed `dev-phone-<your-email>-…`.

### Explicit prefetch

- `mtv dev-phone install` installs Twilio CLI + plugin without launching. Useful in CI seed-up scripts or if an engineer wants the slow part out of the way before doing real work.

### Warm path

- Run `mtv dev-phone` again — no Okta prompt, no profile rewrite if creds still match; ~1s of extra wrapper overhead before the plugin boots.

### Guard-fires paths (direct `twilio dev-phone` use)

- `twilio profiles:use default` (a master-account profile), then `twilio dev-phone` directly → exits with the "locked to subaccount" error pointing to `mtv dev-phone`.
- Unset `MOTIVE_OKTA_EMAIL` and delete `~/.config/motive/dev-phone.env`, then `twilio dev-phone` directly → exits with the "No Motive Okta identity found" error.

### Pass-through args

- `mtv dev-phone -- -p +15551234567 --port 1338` — phone number + port flags reach the plugin.

### Phone-list ownership

- Engineer A runs `mtv dev-phone` and picks `+15551234567`.
- Engineer B runs `mtv dev-phone`. In the dropdown, `+15551234567` shows a red "taken by alice@gomotive.com" badge and the Option is disabled (cannot be selected).
- Calling the API directly (`curl -X POST .../choose-phone-number -d '{"phoneNumber":"+15551234567"}'`) returns HTTP 409 with the owner in the body.
- A "wild" number (webhook to `https://example.com/...`) shows a yellow `taken-external` badge and the existing overwrite warning (still selectable).
- A pristine number shows a green `free` badge.
- After A shuts down, B refreshes; the number flips to `free` and becomes selectable.
- A starts a new session and sees their own previously-taken numbers as selectable (same-owner case).

### Multi-region

- Re-run verification with `MOTIVE_DEV_PHONE_SUBACCOUNT_SID` pointing at a hypothetical EU subaccount + an EU-replicated secret to confirm nothing is hardcoded outside the documented override.

### Unit

- `npm test` in `packages/plugin-dev-phone` — new `identity.test.ts` and `ownership.test.ts` pass.
- `npm test` in `packages/dev-phone-ui` — new `ownership.test.js` passes.

---

## Risks & mitigations

| Risk | Mitigation |
|------|-----------|
| `gh repo fork` fails on KeepTruckin org (HTTP 403 from current token). | Fork via GitHub UI as a one-time admin action. |
| Engineers bypass `mtv` and run `twilio dev-phone` against a master-account profile. | Subaccount guard in code refuses to start; clear error pointing to `mtv dev-phone`. |
| Multiple engineers grab the same number simultaneously (race between UI fetch and choose). | Server-side 409 in `/choose-phone-number` based on fresh Twilio API read. UI badge is best-effort; server is authoritative. |
| Upstream `twilio-labs/dev-phone` evolves and our fork drifts. | `upstream` remote + periodic merge. Keep our diff small and localized in `dev-phone.ts`, `PhoneNumberPicker.jsx`, and the two new utils files. |
| Cold install of plugin from git URL is slow (~30s). | First-run install is opt-in via `mtv dev-phone` itself; engineers who never need it never pay. `mtv dev-phone install` lets them prefetch on their own schedule. Long-term: GitHub Packages. |
| Twilio API key rotation. | `mtv dev-phone` re-fetches both SSM parameters on every run and rewrites the profile — picks up rotations transparently. |

## Follow-ups (out of scope for this PR)

- Terraform the Twilio API key (`twilio_api_key` resource) and SSM parameters so it's reproducible across US/EU regions.
- Move plugin distribution to GitHub Packages (`@motive` scope on `npm.pkg.github.com`) for semver pinning and faster install.
- Replicate the SSM parameters to `eu-central-1` once EU engineers need the tool.
- A `mtv dev-phone rotate-key` helper that creates a new Twilio API Key, swaps the AWS secret atomically, and invalidates the old key.
