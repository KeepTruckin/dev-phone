# dev-phone (Motive fork)

A developer tool for testing SMS and Voice flows against Motive's testing Twilio subaccount.

This is the Motive fork of [twilio-labs/dev-phone](https://github.com/twilio-labs/dev-phone). It adds:

- A hard **subaccount lock** so the tool only ever talks to the Motive subaccount.
- **Okta-stamped resource naming** so every dev-phone session is attributable to a real engineer.
- A phone-number **ownership indicator** in the picker. Each number is labeled `free`, `yours`, `taken by <email>`, or `external webhook`. Numbers actively in use by another engineer's dev-phone are disabled in the dropdown and the server returns HTTP 409 if anything tries to steal them.

The monorepo contains two packages:

* `@motive/plugin-dev-phone` — the Twilio CLI plugin (deploys account resources + serves the UI).
* `@motive/dev-phone-ui` — the React UI tightly coupled to the plugin.

## Quick start

Run the wrapper from [`local-dev`](https://github.com/KeepTruckin/local-dev):

```bash
mtv dev-phone
```

That single command:

1. Installs the Twilio CLI and this plugin if missing (opt-in — bootstrap does **not** do this for you).
2. Triggers `mtv aws auth` if your Okta-backed AWS credentials are stale.
3. Fetches the subaccount SID + API key SID + secret from AWS SSM Parameter Store (`/dev-phone/prvw/use1/core/account-sid`, `…/api-key-sid`, `…/api-secret` in `mtv-nonproduction` / `us-east-1`).
4. Writes a managed Twilio CLI profile named `dev-phone` (secret stored in the OS keychain — no plaintext on disk).
5. Stamps the run with your Okta email and launches `twilio dev-phone`.

Other actions:

```bash
mtv dev-phone install   # prefetch Twilio CLI + plugin without launching
mtv dev-phone status    # show current install state, profile, cached identity
mtv dev-phone login     # refresh the Twilio profile without launching
mtv dev-phone logout    # remove the managed profile + cached identity
```

## Manual install (without mtv)

If you don't have `mtv` available, install the plugin directly and launch it via the Twilio CLI:

```bash
twilio plugins:install git+https://github.com/KeepTruckin/dev-phone.git#main
twilio dev-phone
```

Prerequisites for the direct path:

1. An active Twilio CLI profile configured against Motive's testing subaccount (its SID is stored in the SSM parameter `/dev-phone/prvw/use1/core/account-sid`; fetch with `mtv secret view us-east-1 prvw dev-phone core account-sid`). The plugin refuses to start against any other account.
2. `MOTIVE_OKTA_EMAIL` set in the environment (e.g. `export MOTIVE_OKTA_EMAIL="$(whoami)@gomotive.com"`), or a `~/.config/motive/dev-phone.env` file containing `MOTIVE_OKTA_EMAIL=<your-email>`. This stamps every Twilio resource the plugin creates with your identity. `mtv dev-phone` writes this file for you.
3. `MOTIVE_DEV_PHONE_SUBACCOUNT_SID` set in the environment to the subaccount SID the plugin should accept. `mtv dev-phone` exports this automatically from the SSM parameter.

## Environment variables

| Variable                          | Required by plugin | Purpose                                                    |
| --------------------------------- | ------------------ | ---------------------------------------------------------- |
| `MOTIVE_OKTA_EMAIL`               | Yes                | Caller's Okta email; stamps all Twilio resources.          |
| `MOTIVE_DEV_PHONE_SUBACCOUNT_SID` | Yes                | Subaccount SID the plugin is allowed to talk to. Not hardcoded — sourced from SSM by the wrapper. |

## How phone-number ownership works

When the picker lists numbers from the subaccount, each entry includes an `ownership` field computed from the webhook URL configured on the number:

| State              | Webhook                                              | UI                                              |
| ------------------ | ---------------------------------------------------- | ----------------------------------------------- |
| `free`             | No SMS / voice webhook set.                          | Green badge, selectable.                        |
| `taken` (yours)    | `https://dev-phone-<your-email-slug>-<rand>.twil.io` | Yellow "yours" label, selectable.               |
| `taken` (other)    | `https://dev-phone-<other-email-slug>-<rand>.twil.io`| Red "taken by <email>" label, **disabled**.     |
| `taken-external`   | Any other URL.                                       | "external webhook", selectable with overwrite warning. |

The server enforces the same rule: `POST /choose-phone-number` returns HTTP 409 if you try to claim a number owned by someone else.

## Contributing

See [DEVELOPMENT.md](DEVELOPMENT.md). [MOTIVE-INTEGRATION.md](MOTIVE-INTEGRATION.md) at the repo root captures the architectural rationale for the Motive-specific changes (subaccount lock, ownership classifier, mtv wrapper).
