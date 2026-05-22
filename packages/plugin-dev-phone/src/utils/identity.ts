/**
 * Motive identity helpers for the dev-phone plugin.
 *
 * The plugin runs locked to Motive's Twilio subaccount and stamps every
 * resource it creates with the caller's Okta email so the resources are
 * attributable in the Twilio Console.
 *
 * The caller's email is provided by `mtv dev-phone`, which sets
 * `MOTIVE_OKTA_EMAIL` and writes the same value to a cached env file at
 * `~/.config/motive/dev-phone.env` (mode 0600). This helper checks the env
 * var first and falls back to the file.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';

export const DEV_PHONE_ENV_FILE = path.join(
    os.homedir(),
    '.config',
    'motive',
    'dev-phone.env',
);

const EMAIL_RE = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/;

/**
 * Returns the caller's Okta email or `null` if none can be resolved.
 *
 * Resolution order:
 *   1. `process.env.MOTIVE_OKTA_EMAIL`
 *   2. `MOTIVE_OKTA_EMAIL=` line in `~/.config/motive/dev-phone.env`
 */
export function getCallerEmail(
    env: NodeJS.ProcessEnv = process.env,
    envFile: string = DEV_PHONE_ENV_FILE,
): string | null {
    const fromEnv = (env.MOTIVE_OKTA_EMAIL || '').trim();
    if (fromEnv && EMAIL_RE.test(fromEnv)) {
        return fromEnv;
    }

    const fromFile = readEmailFromFile(envFile);
    if (fromFile && EMAIL_RE.test(fromFile)) {
        return fromFile;
    }

    return null;
}

function readEmailFromFile(envFile: string): string | null {
    let contents: string;
    try {
        contents = fs.readFileSync(envFile, 'utf8');
    } catch {
        return null;
    }

    for (const rawLine of contents.split(/\r?\n/)) {
        const line = rawLine.trim();
        if (!line || line.startsWith('#')) continue;
        const match = line.match(/^MOTIVE_OKTA_EMAIL\s*=\s*(.+)$/);
        if (match) {
            return match[1].trim();
        }
    }
    return null;
}

/**
 * Returns an email-derived slug that is safe to embed in Twilio friendly names,
 * webhook hostnames, and oclif resource identifiers.
 *
 * The encoding is round-trip-safe for the characters Motive emails actually
 * use: `.`, `+`, `_`, `-`, and `@`. Each is replaced with a distinctive token
 * so `unslugEmail` can reverse it without ambiguity.
 *
 * `first.last+work@gomotive.com` → `first-dot-last-plus-work-at-gomotive-dot-com`
 */
export function slugEmail(email: string): string {
    return email
        .toLowerCase()
        .replace(/@/g, '-at-')
        .replace(/\./g, '-dot-')
        .replace(/\+/g, '-plus-')
        .replace(/_/g, '-underscore-')
        // Anything else (e.g. unicode in display names that ended up here)
        // collapses to a single hyphen so we still produce valid DNS labels.
        .replace(/[^a-z0-9-]+/g, '-')
        .replace(/-{2,}/g, '-')
        .replace(/^-+|-+$/g, '');
}

export function slugEmailLocalPart(email: string): string {
    const localPart = email.split('@')[0] || email;
    return localPart
        .toLowerCase()
        .replace(/[._+]+/g, '-')
        .replace(/[^a-z0-9-]+/g, '-')
        .replace(/-{2,}/g, '-')
        .replace(/^-+|-+$/g, '');
}

/**
 * Inverse of `slugEmail` for slugs we generated ourselves. Round-trips emails
 * that only use `.`, `+`, `_`, `-`, and `@`. Returns the slug unchanged when
 * the `-at-` marker is missing.
 */
export function unslugEmail(slug: string): string {
    const idx = slug.lastIndexOf('-at-');
    if (idx === -1) return slug;
    const decode = (s: string) =>
        s
            .replace(/-dot-/g, '.')
            .replace(/-plus-/g, '+')
            .replace(/-underscore-/g, '_');
    return `${decode(slug.slice(0, idx))}@${decode(slug.slice(idx + '-at-'.length))}`;
}

/**
 * Returns true when two emails canonicalize to the same slug. Use this
 * instead of comparing reconstructed emails directly — `unslugEmail` can lose
 * information for emails that contained characters outside our token set, so
 * slug equality is the source of truth.
 */
export function emailsMatch(a: string, b: string): boolean {
    if (!a || !b) return false;
    return slugEmail(a) === slugEmail(b);
}

/**
 * Cryptographically-weak short random suffix used to distinguish multiple
 * dev-phone sessions from the same engineer. 4 chars from [a-z0-9].
 */
export function shortRandom(length = 4): string {
    const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
    let out = '';
    for (let i = 0; i < length; i++) {
        out += alphabet.charAt(Math.floor(Math.random() * alphabet.length));
    }
    return out;
}
