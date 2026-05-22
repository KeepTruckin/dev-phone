const { expect } = require('chai');
const { ownershipFor } = require('../../dist/utils/ownership');

describe('utils/ownership.ownershipFor', () => {
    it('returns "free" when neither voiceUrl nor smsUrl is set', () => {
        expect(ownershipFor({})).to.deep.equal({ state: 'free' });
        expect(ownershipFor({ voiceUrl: '', smsUrl: null })).to.deep.equal({ state: 'free' });
    });

    it('parses owner from a Motive-shaped dev-phone webhook URL', () => {
        const ownership = ownershipFor({
            voiceUrl: 'https://dev-phone-alice-at-gomotive-com-9xq2.twil.io/incoming-call',
        });
        expect(ownership).to.deep.equal({
            state: 'taken',
            owner: 'alice@gomotive.com',
        });
    });

    it('falls back to voiceUrl when only voice is set', () => {
        const ownership = ownershipFor({
            voiceUrl: 'https://dev-phone-bob-at-gomotive-com-abcd.twil.io/incoming-call',
            smsUrl: null,
        });
        expect(ownership.state).to.equal('taken');
        expect(ownership.owner).to.equal('bob@gomotive.com');
    });

    it('falls back to smsUrl when voiceUrl is missing', () => {
        const ownership = ownershipFor({
            voiceUrl: '',
            smsUrl: 'https://dev-phone-bob-at-gomotive-com-abcd.twil.io/incoming-message',
        });
        expect(ownership.state).to.equal('taken');
        expect(ownership.owner).to.equal('bob@gomotive.com');
    });

    it('returns "taken" without owner for dev-phone URLs whose slug is unparseable', () => {
        // upstream dev-phone's name format was `dev-phone-1234.twil.io` —
        // matches the prefix regex but not the slug-with-owner regex.
        const ownership = ownershipFor({
            voiceUrl: 'https://dev-phone-1234.twil.io/incoming-call',
        });
        expect(ownership).to.deep.equal({ state: 'taken' });
    });

    it('returns "taken-external" for non-dev-phone webhook URLs', () => {
        const ownership = ownershipFor({
            voiceUrl: 'https://example.com/twilio/voice',
        });
        expect(ownership).to.deep.equal({ state: 'taken-external' });
    });
});
