/**
 * Ownership helpers shared between the PhoneNumberPicker UI and any unit tests.
 *
 * The server side (`/phone-numbers`) attaches an `ownership` field to each
 * number describing whether it is `free`, `taken` (by a Motive engineer's
 * running dev-phone), or `taken-external` (configured by some non-dev-phone
 * webhook). These helpers turn that into display strings and Paste Badge
 * variants.
 */

export const OWNERSHIP_STATES = Object.freeze({
    FREE: "free",
    TAKEN: "taken",
    TAKEN_EXTERNAL: "taken-external",
});

/**
 * Returns true when the number is owned by another engineer and should be
 * unselectable in the dropdown. Same-owner case is allowed (the engineer
 * reconnecting to a number their previous session left configured).
 */
export function isDisabledForCurrentUser(ownership, currentUserEmail) {
    if (!ownership || ownership.state !== OWNERSHIP_STATES.TAKEN) return false;
    if (!ownership.owner) return false; // unknown owner — let the user proceed (likely a stale dev-phone)
    return ownership.owner !== currentUserEmail;
}

/**
 * Paste Badge `variant` for the ownership state.
 */
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

/**
 * Short label rendered in the dropdown Option next to the phone number.
 */
export function badgeLabelFor(ownership, currentUserEmail) {
    if (!ownership) return "";
    switch (ownership.state) {
        case OWNERSHIP_STATES.FREE:
            return "free";
        case OWNERSHIP_STATES.TAKEN_EXTERNAL:
            return "external webhook";
        case OWNERSHIP_STATES.TAKEN:
            if (!ownership.owner) return "taken";
            if (ownership.owner === currentUserEmail) return "yours";
            return `taken by ${ownership.owner}`;
        default:
            return "";
    }
}

/**
 * Sort order for the dropdown: free first, then external webhooks (still
 * selectable), then numbers taken by others (disabled), then unknown.
 */
export function ownershipSortRank(ownership) {
    switch (ownership?.state) {
        case OWNERSHIP_STATES.FREE:
            return 0;
        case OWNERSHIP_STATES.TAKEN_EXTERNAL:
            return 1;
        case OWNERSHIP_STATES.TAKEN:
            return 2;
        default:
            return 3;
    }
}
