const { expect } = require('chai');
const { ownershipFor } = require('../../dist/utils/ownership');

const DEMO_SMS = 'https://demo.twilio.com/welcome/sms/reply';
const DEMO_VOICE = 'https://demo.twilio.com/welcome/voice/';

describe('utils/ownership.ownershipFor', () => {
    it('returns "free" when both URLs are unset', () => {
        expect(ownershipFor({})).to.deep.equal({ state: 'free' });
        expect(ownershipFor({ voiceUrl: '', smsUrl: null })).to.deep.equal({ state: 'free' });
    });

    it('treats Twilio demo URLs as unset (free)', () => {
        expect(ownershipFor({ voiceUrl: DEMO_VOICE, smsUrl: DEMO_SMS }))
            .to.deep.equal({ state: 'free' });
        expect(ownershipFor({ voiceUrl: DEMO_VOICE })).to.deep.equal({ state: 'free' });
        expect(ownershipFor({ smsUrl: DEMO_SMS })).to.deep.equal({ state: 'free' });
    });

    it('parses owner from a Motive-shaped dev-phone webhook URL', () => {
        const ownership = ownershipFor({
            voiceUrl: 'https://dev-phone-alice-at-gomotive-dot-com-9xq2.twil.io/incoming-call',
        });
        expect(ownership.state).to.equal('taken');
        expect(ownership.ownerSlug).to.equal('alice-at-gomotive-dot-com');
        expect(ownership.ownerDisplay).to.equal('alice@gomotive.com');
    });

    it('classifies as taken when only smsUrl is a dev-phone URL', () => {
        const ownership = ownershipFor({
            voiceUrl: '',
            smsUrl: 'https://dev-phone-bob-at-gomotive-dot-com-abcd.twil.io/incoming-message',
        });
        expect(ownership.state).to.equal('taken');
        expect(ownership.ownerDisplay).to.equal('bob@gomotive.com');
    });

    it('classifies as taken when one channel is dev-phone and the other is the Twilio demo', () => {
        const ownership = ownershipFor({
            voiceUrl: DEMO_VOICE,
            smsUrl: 'https://dev-phone-bob-at-gomotive-dot-com-abcd.twil.io/incoming-message',
        });
        expect(ownership.state).to.equal('taken');
        expect(ownership.ownerDisplay).to.equal('bob@gomotive.com');
    });

    it('prefers a dev-phone classification over taken-external when one channel is each', () => {
        const ownership = ownershipFor({
            voiceUrl: 'https://example.com/twilio/voice',
            smsUrl: 'https://dev-phone-bob-at-gomotive-dot-com-abcd.twil.io/incoming-message',
        });
        expect(ownership.state).to.equal('taken');
        expect(ownership.ownerDisplay).to.equal('bob@gomotive.com');
    });

    it('returns "taken" without owner for dev-phone URLs whose slug is unparseable', () => {
        // upstream dev-phone's name format was `dev-phone-1234.twil.io` —
        // matches the prefix regex but not the slug-with-owner regex.
        const ownership = ownershipFor({
            voiceUrl: 'https://dev-phone-1234.twil.io/incoming-call',
        });
        expect(ownership).to.deep.equal({ state: 'taken' });
    });

    it('returns "taken-external" when only non-dev-phone webhooks are configured', () => {
        expect(ownershipFor({ voiceUrl: 'https://example.com/twilio/voice' }))
            .to.deep.equal({ state: 'taken-external' });
        expect(ownershipFor({
            voiceUrl: 'https://example.com/voice',
            smsUrl: 'https://example.com/sms',
        })).to.deep.equal({ state: 'taken-external' });
    });
});
