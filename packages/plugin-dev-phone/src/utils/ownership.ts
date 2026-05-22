/**
 * Server-side classifier for Twilio phone-number ownership.
 *
 * A number is `free` when it has no real webhook (no URL set, or both URLs
 * point at Twilio's default demo endpoints). It is `taken` when at least one
 * of its webhooks points at a dev-phone-shaped URL; the owner is identified
 * by the URL slug. Anything else is `taken-external` — someone wired the
 * number up to a non-Motive endpoint and the existing overwrite-on-confirm
 * flow handles it.
 *
 * The `owner` field is the raw slug as parsed from the URL — not a
 * reconstructed email — so call sites that need to compare ownership against
 * the current caller must use `slugEmail(callerEmail)` (or `emailsMatch`)
 * rather than string-compare reconstructed emails. The `ownerDisplay` field
 * is the best-effort decoded email purely for UI rendering.
 */

import { unslugEmail } from './identity';

const DEV_PHONE_URL_RE = /https?:\/\/dev-phone-([a-z0-9-]+?)-[a-z0-9]{4,}\./i;
const DEV_PHONE_PREFIX_RE = /https?:\/\/dev-phone-/i;

// Twilio sets these on freshly-purchased numbers; treat them as "unset".
const TWILIO_DEMO_URLS = new Set([
    'https://demo.twilio.com/welcome/sms/reply',
    'https://demo.twilio.com/welcome/voice/',
]);

export type PnOwnership =
    | { state: 'free' }
    | { state: 'taken'; ownerSlug?: string; ownerDisplay?: string }
    | { state: 'taken-external' };

type ChannelClassification =
    | { kind: 'unset' }
    | { kind: 'dev-phone'; ownerSlug?: string }
    | { kind: 'external' };

function classifyUrl(url: string | null | undefined): ChannelClassification {
    if (!url || TWILIO_DEMO_URLS.has(url)) {
        return { kind: 'unset' };
    }

    const match = url.match(DEV_PHONE_URL_RE);
    if (match) {
        return { kind: 'dev-phone', ownerSlug: match[1] };
    }
    if (DEV_PHONE_PREFIX_RE.test(url)) {
        // dev-phone-shaped URL but the slug wasn't parseable (e.g. configured
        // by upstream's random-name version before the Motive rename).
        return { kind: 'dev-phone' };
    }
    return { kind: 'external' };
}

export function ownershipFor(pn: {
    voiceUrl?: string | null;
    smsUrl?: string | null;
}): PnOwnership {
    const voice = classifyUrl(pn.voiceUrl);
    const sms = classifyUrl(pn.smsUrl);

    if (voice.kind === 'unset' && sms.kind === 'unset') {
        return { state: 'free' };
    }

    // Prefer a dev-phone classification (owner attribution) over an external
    // webhook, since "taken by alice" is more actionable than "taken-external".
    const devPhone =
        voice.kind === 'dev-phone' ? voice : sms.kind === 'dev-phone' ? sms : null;

    if (devPhone) {
        if (devPhone.ownerSlug) {
            return {
                state: 'taken',
                ownerSlug: devPhone.ownerSlug,
                ownerDisplay: unslugEmail(devPhone.ownerSlug),
            };
        }
        return { state: 'taken' };
    }

    return { state: 'taken-external' };
}
