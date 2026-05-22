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
 * `alice@gomotive.com` → `alice-at-gomotive-com`
 */
export function slugEmail(email: string): string {
    return email
        .toLowerCase()
        .replace(/@/g, '-at-')
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '');
}

/**
 * Inverse of `slugEmail` for slugs we generated ourselves. Recovers the
 * original email when given a slug like `alice-at-gomotive-com`; returns
 * the slug unchanged if the `-at-` marker is missing.
 */
export function unslugEmail(slug: string): string {
    const idx = slug.lastIndexOf('-at-');
    if (idx === -1) return slug;
    const local = slug.slice(0, idx);
    const domain = slug.slice(idx + '-at-'.length).replace(/-/g, '.');
    return `${local}@${domain}`;
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
