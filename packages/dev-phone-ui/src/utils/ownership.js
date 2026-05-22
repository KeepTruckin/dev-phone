/**
 * Ownership helpers shared between the PhoneNumberPicker UI and unit tests.
 *
 * The server (`/phone-numbers`) attaches an `ownership` object to each number:
 *
 *   { state: "free" }
 *   { state: "taken", ownerSlug, ownerDisplay, isYou }
 *   { state: "taken-external" }
 *
 * The UI never compares emails itself — that's the server's job, since only
 * the server canonically knows the caller's Okta email and how to slug it.
 * The UI just reads `isYou` and `ownerDisplay`.
 */

export const OWNERSHIP_STATES = Object.freeze({
    FREE: "free",
    TAKEN: "taken",
    TAKEN_EXTERNAL: "taken-external",
});

/**
 * Returns true when the Option should be unselectable: another engineer's
 * running dev-phone owns the number. Returns false when the owner is the
 * current caller, when no owner could be parsed, or when the number is free /
 * has a non-dev-phone webhook.
 */
export function isDisabledForCurrentUser(ownership) {
    if (!ownership || ownership.state !== OWNERSHIP_STATES.TAKEN) return false;
    if (!ownership.ownerSlug) return false; // unknown owner; let the user proceed
    if (ownership.isYou) return false;
    return true;
}

/** Paste Badge `variant` for the ownership state. */
export function badgeVariantFor(ownership) {
    switch (ownership?.state) {
        case OWNERSHIP_STATES.FREE:
            return "success";
        case OWNERSHIP_STATES.TAKEN_EXTERNAL:
            return "warning";
        case OWNERSHIP_STATES.TAKEN:
            return "error";
        default:
            return "neutral";
    }
}

/** Short label rendered in the dropdown Option next to the phone number. */
export function badgeLabelFor(ownership) {
    if (!ownership) return "";
    switch (ownership.state) {
        case OWNERSHIP_STATES.FREE:
            return "free";
        case OWNERSHIP_STATES.TAKEN_EXTERNAL:
            return "external webhook";
        case OWNERSHIP_STATES.TAKEN: {
            if (ownership.isYou) return "yours";
            const owner = ownership.ownerDisplay || ownership.ownerSlug;
            return owner ? `taken by ${owner}` : "taken";
        }
        default:
            return "";
    }
}

/**
 * Sort order for the dropdown: free first (selectable + idle), then external
 * webhooks (selectable with warning), then your own numbers (selectable,
 * marked "yours"), then numbers taken by others (disabled).
 */
export function ownershipSortRank(ownership) {
    switch (ownership?.state) {
        case OWNERSHIP_STATES.FREE:
            return 0;
        case OWNERSHIP_STATES.TAKEN_EXTERNAL:
            return 1;
        case OWNERSHIP_STATES.TAKEN:
            return ownership.isYou ? 2 : 3;
        default:
            return 4;
    }
}
