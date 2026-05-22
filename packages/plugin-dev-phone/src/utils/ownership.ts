/**
 * Server-side classifier for Twilio phone-number ownership.
 *
 * A number is "free" when it has no webhook configured. It is "taken" when the
 * webhook points at a dev-phone-shaped URL (`https://dev-phone-<slug>-<rand>.…`);
 * the owner is extracted from the slug when present. Any other webhook is
 * "taken-external" — someone configured the number with a non-Motive endpoint
 * and the existing overwrite-on-confirm path handles it.
 */

import { unslugEmail } from './identity';

const DEV_PHONE_URL_RE = /https?:\/\/dev-phone-([a-z0-9-]+?)-[a-z0-9]{4,}\./i;
const DEV_PHONE_PREFIX_RE = /https?:\/\/dev-phone-/i;

export type PnOwnership =
    | { state: 'free' }
    | { state: 'taken'; owner?: string }
    | { state: 'taken-external' };

export function ownershipFor(pn: {
    voiceUrl?: string | null;
    smsUrl?: string | null;
}): PnOwnership {
    const url = pn.voiceUrl || pn.smsUrl || '';
    if (!url) return { state: 'free' };

    const m = url.match(DEV_PHONE_URL_RE);
    if (m) {
        return { state: 'taken', owner: unslugEmail(m[1]) };
    }
    if (DEV_PHONE_PREFIX_RE.test(url)) {
        // dev-phone-shaped URL but the slug wasn't parseable (e.g. configured
        // by upstream's random-name version before the Motive rename).
        return { state: 'taken' };
    }
    return { state: 'taken-external' };
}
