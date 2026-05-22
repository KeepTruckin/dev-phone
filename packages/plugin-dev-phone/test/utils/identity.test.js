const fs = require('fs');
const os = require('os');
const path = require('path');
const { expect } = require('chai');

const {
    getCallerEmail,
    slugEmail,
    unslugEmail,
    shortRandom,
    DEV_PHONE_ENV_FILE,
} = require('../../dist/utils/identity');

describe('utils/identity', () => {
    describe('getCallerEmail', () => {
        let tmpFile;

        afterEach(() => {
            if (tmpFile && fs.existsSync(tmpFile)) {
                fs.unlinkSync(tmpFile);
            }
            tmpFile = undefined;
        });

        it('returns the email from MOTIVE_OKTA_EMAIL when set and valid', () => {
            const email = getCallerEmail(
                { MOTIVE_OKTA_EMAIL: 'alice@gomotive.com' },
                '/does/not/exist',
            );
            expect(email).to.equal('alice@gomotive.com');
        });

        it('trims whitespace around the env var', () => {
            const email = getCallerEmail(
                { MOTIVE_OKTA_EMAIL: '  alice@gomotive.com  ' },
                '/does/not/exist',
            );
            expect(email).to.equal('alice@gomotive.com');
        });

        it('rejects an env value that is not an email', () => {
            const email = getCallerEmail(
                { MOTIVE_OKTA_EMAIL: 'not-an-email' },
                '/does/not/exist',
            );
            expect(email).to.equal(null);
        });

        it('falls back to the env file when the env var is missing', () => {
            tmpFile = path.join(os.tmpdir(), `motive-dev-phone-${Date.now()}.env`);
            fs.writeFileSync(
                tmpFile,
                '# comment\n\nMOTIVE_OKTA_EMAIL=bob@gomotive.com\nOTHER=ignored\n',
            );
            const email = getCallerEmail({}, tmpFile);
            expect(email).to.equal('bob@gomotive.com');
        });

        it('returns null when env var missing and file missing', () => {
            expect(getCallerEmail({}, '/does/not/exist')).to.equal(null);
        });

        it('exports the canonical env file path under the home dir', () => {
            expect(DEV_PHONE_ENV_FILE).to.equal(
                path.join(os.homedir(), '.config', 'motive', 'dev-phone.env'),
            );
        });
    });

    describe('slugEmail / unslugEmail', () => {
        it('round-trips a simple email', () => {
            const slug = slugEmail('alice@gomotive.com');
            expect(slug).to.equal('alice-at-gomotive-com');
            expect(unslugEmail(slug)).to.equal('alice@gomotive.com');
        });

        it('lowercases and strips uncommon characters', () => {
            expect(slugEmail('Alice.QA+test@Gomotive.com')).to.equal(
                'alice-qa-test-at-gomotive-com',
            );
        });

        it('returns the slug unchanged when no -at- marker is present', () => {
            expect(unslugEmail('weird-slug')).to.equal('weird-slug');
        });
    });

    describe('shortRandom', () => {
        it('returns a string of the requested length using only [a-z0-9]', () => {
            const value = shortRandom(8);
            expect(value).to.have.lengthOf(8);
            expect(value).to.match(/^[a-z0-9]+$/);
        });

        it('defaults to length 4', () => {
            expect(shortRandom()).to.have.lengthOf(4);
        });
    });
});
