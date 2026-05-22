import path from 'path';
import fs from 'fs';
import open from 'open';
import express from 'express';
import confirm from '@inquirer/confirm';

import { Flags } from '@oclif/core';
import { deployServerless, constants } from '../utils/create-serverless-util';
import { getAvailablePort, isValidPort } from '../utils/helpers'
import { isSmsUrlSet, isVoiceUrlSet, updatePhoneWebhooks, removePhoneWebhooks } from '../utils/phone-number-utils';
import { getCallerEmail, slugEmail, slugEmailLocalPart } from '../utils/identity';
import { ownershipFor, PnOwnership } from '../utils/ownership';
const { TwilioClientCommand } = require('@twilio/cli-core').baseCommands;
const { TwilioCliError } = require('@twilio/cli-core').services.error;
const WebClientPath = path.resolve(require.resolve('@motive/dev-phone-ui'), '..')
const { version } = require('../../package.json');

// Types
import { ServiceInstance as ServerlessServiceInstance } from 'twilio/lib/rest/serverless/v1/service'
import { ServiceInstance as SyncServiceInstance } from 'twilio/lib/rest/sync/v1/service'
import { KeyInstance } from 'twilio/lib/rest/api/v2010/account/key'
import { ApplicationInstance } from 'twilio/lib/rest/api/v2010/account/application'
import { IncomingPhoneNumberInstance } from 'twilio/lib/rest/api/v2010/account/incomingPhoneNumber'

const AccessToken = require('twilio').jwt.AccessToken;
const ChatGrant = AccessToken.ChatGrant;
const VoiceGrant = AccessToken.VoiceGrant;
const SyncGrant = AccessToken.SyncGrant;
const CALL_LOG_MAP_NAME = 'CallLog'

// Motive: the dev-phone is locked to a single Twilio subaccount. The SID is
// supplied by the `mtv dev-phone` wrapper (which reads it from an SSM
// parameter at runtime) and passed in via MOTIVE_DEV_PHONE_SUBACCOUNT_SID.
// Never hardcode the SID here — it would land in source-control history and
// trip the org-wide secret-scanning rules.
const EXPECTED_SUBACCOUNT_SID = process.env.MOTIVE_DEV_PHONE_SUBACCOUNT_SID || '';

const SUPPORT_RUNBOOK_URL = 'https://k2labs.atlassian.net/wiki/spaces/AM/pages/6610124943/Testing+SMS+Flows';
const SUPPORT_SLACK_CHANNEL = '#eng-customer-platform-support';
const SUPPORT_FOOTER =
    `\n💬 Need help? Slack: ${SUPPORT_SLACK_CHANNEL}\n` +
    `   Runbook: ${SUPPORT_RUNBOOK_URL}\n`;

// Decorates ownership with `isYou` based on slug comparison against the
// caller. We do the comparison server-side so the UI doesn't need to know how
// to slug emails — it just consults the boolean.
const decorateOwnership = (ownership: PnOwnership, callerEmail: string): PnOwnership & { isYou?: boolean } => {
    if (ownership.state !== 'taken' || !ownership.ownerSlug) return ownership;
    if (!callerEmail) return ownership;
    const ownerSlugs = [slugEmail(callerEmail), slugEmailLocalPart(callerEmail)];
    return { ...ownership, isYou: ownerSlugs.includes(ownership.ownerSlug) };
};

// removes unecessary properties to standardize the twilio phone number
const reformatTwilioPns = (twilioResponse: IncomingPhoneNumberInstance[], callerEmail = '') => {
    return {
        "phone-numbers": twilioResponse.map(
            ({ phoneNumber, friendlyName, smsUrl, voiceUrl, sid }) =>
                ({
                    phoneNumber,
                    friendlyName,
                    smsUrl,
                    voiceUrl,
                    sid,
                    ownership: decorateOwnership(ownershipFor({ smsUrl, voiceUrl }), callerEmail),
                }))
    }
}

// Use the full email slug (not just the local part) so engineers with the same
// local-part on different domains — or local-parts that normalize to the same
// slug — get distinct Twilio resource names. Matches the documented webhook
// format `dev-phone-<email-slug>-<rand>.twil.io` after Twilio appends the
// serverless deployment suffix.
const generatePhoneName = (email: string) => {
    return `dev-phone-${slugEmail(email)}`;
}

class DevPhoneServer extends TwilioClientCommand {
    constructor(argv: any, config: any, secureStorage: any) {
        super(argv, config, secureStorage);
        this.cliSettings = {};
        this.pns = [];
        this.port = 1337
        this.jwt = null;
        this.apikey = {};
        this.twimlApp = {};
        // Motive: filled in once we resolve the caller's Okta email in run().
        this.devPhoneName = '';
        this.callerEmail = '';
        this.voiceUrl = null;
        this.smsUrl = null;
        this.voiceOutboundUrl = null;
    }

    async run() {
        // Motive: resolve identity before talking to Twilio. We need this for
        // every resource we'll create, so failing fast here keeps the Twilio
        // account clean if the user forgot to run `mtv dev-phone`.
        const callerEmail = getCallerEmail();
        if (!callerEmail) {
            console.error(
                '\n❌ No Motive Okta identity found.\n' +
                '   Set MOTIVE_OKTA_EMAIL or run: mtv dev-phone\n' +
                SUPPORT_FOOTER,
            );
            process.exit(1);
        }
        this.callerEmail = callerEmail;
        this.devPhoneName = generatePhoneName(callerEmail);

        if (!EXPECTED_SUBACCOUNT_SID) {
            console.error(
                '\n❌ MOTIVE_DEV_PHONE_SUBACCOUNT_SID is not set.\n' +
                '   The dev-phone plugin must be launched via `mtv dev-phone`, which fetches\n' +
                '   the SID from AWS SSM Parameter Store and exports it for the plugin.\n' +
                SUPPORT_FOOTER,
            );
            process.exit(1);
        }

        await super.run();

        // Motive: refuse to run against any account other than the locked subaccount.
        if (this.twilioClient.accountSid !== EXPECTED_SUBACCOUNT_SID) {
            console.error(
                `\n❌ dev-phone is locked to subaccount ${EXPECTED_SUBACCOUNT_SID}.\n` +
                `   Current Twilio profile points at ${this.twilioClient.accountSid}.\n` +
                `   Run: mtv dev-phone\n` +
                SUPPORT_FOOTER,
            );
            process.exit(1);
        }

        const props = this.parseProperties() || {};
        await this.validatePropsAndFlags(props, this.flags)

        console.log(`Hello 👋 ${this.callerEmail} — your dev-phone is "${this.devPhoneName}"`)
        console.log(`   Subaccount: ${EXPECTED_SUBACCOUNT_SID}`)
        console.log(SUPPORT_FOOTER)

        // Tag every Twilio API call with our fork identifier so Twilio-side
        // logs/telemetry show the Motive fork (and version) instead of the
        // upstream `@twilio-labs/*` strings.
        this.twilioClient.userAgentExtensions = [
            `@motive/dev-phone/${version}`,
            `@motive/dev-phone/helper-library`,
            'serverless-functions'
        ]

        // create API KEY and API SECRET to be generate JWT AccessToken for ChatGrant, VoiceGrant and SyncGrant
        this.apikey = await this.reuseOrCreateApiKey();

        const isDeletingAll = () => !!this.flags.clear;

        const deleteAll = async () => {
          await this.destroyAllConversations();
          await this.destroyAllTwimlApps();
          await this.destroyAllApiKeys();
          await this.destroyAllSyncs();
          await this.destroyAllFunctions();
          await this.removeAllPhoneWebhooks();
        }

        if (isDeletingAll()) {
            const deleteAllConfirmation = await confirm({
                message: "Do you want to delete all of the dev phone resources on your Twilio account? This may interfere with other instances of the Dev Phone.",
                default: false
            })
            if(deleteAllConfirmation){
                console.log(`🌐 Deleting all dev-phone resources from your account before starting...`)
                await deleteAll().finally(() => console.log(`✅ All resources have been deleted.`));
            }
        }

        // create conversation for SMS/web interface
        this.conversation = await this.createConversation();

        // create Sync for Call History interface
        this.sync = await this.createSync();

        // create Function to handle inbound-voice, inbound-sms and outbound-voice (voip)
        this.serverless = await this.createFunction();

        // create TwiML App
        this.twimlApp = await this.createTwimlApp();

        // create JWT Access Token with ChatGrant, VoiceGrant and SyncGrant
        this.jwt = await this.createJwt();

        // add webhook config to the phone number, if there is one passed by CLI flag
        // TO-DO return updated phone number and set this.phoneNumber
        const phoneNumberProps =  {voiceUrl: this.voiceUrl, smsUrl: this.smsUrl, statusCallback: this.statusCallback}
        this.cliSettings.phoneNumber =  await updatePhoneWebhooks(this.cliSettings.phoneNumber,this.twilioClient.incomingPhoneNumbers, phoneNumberProps );

        const onShutdown = async () => {
            await this.destroyConversations();
            await this.destroyTwimlApps();
            await this.destroyApiKeys();
            await this.destroySyncs();
            await this.destroyFunction();
            await removePhoneWebhooks(this.cliSettings.phoneNumber, this.twilioClient.incomingPhoneNumbers);
        }

        process.on("SIGTERM", async function () {
            console.log("\n👋 Shutting down");
            await onShutdown().finally(() => process.exit(0));
        });

        process.on('SIGINT', async function () {
            console.log("\n👋 Shutting down");
            await onShutdown().finally(() => process.exit(0));
        });

        const app = express();

        // serve assets from the "public" directory
        // __dirname is the path to _this_ file, so ../../public to find index.html
        app.use(express.static(WebClientPath));

        app.use(express.json()); // response body writer

        app.get("/ping", (req, res) => {
            res.json({ pong: true });

            console.log('TWILIO', this.twilioClient);
        })

        app.get("/plugin-settings", (req, res) => {
            res.json({
                ...this.cliSettings,
                devPhoneName: this.devPhoneName,
                currentUserEmail: this.callerEmail,
                subaccountSid: EXPECTED_SUBACCOUNT_SID,
                conversation: this.conversation
            });
        })

        app.get("/phone-numbers", async (req: express.Request, res: express.Response) => {
            if (this.pns.length === 0) {
                try {
                    const pns = await this.twilioClient.incomingPhoneNumbers.list()
                    this.pns = pns
                    res.json(reformatTwilioPns(pns, this.callerEmail))
                } catch (err: any) {
                    console.error('Phone number API threw an error', err);
                    res.status(err.status ? err.status : 400).send({ error: err })
                }
            } else {
                res.json(reformatTwilioPns(this.pns, this.callerEmail));
            }
        })

        app.post("/send-sms", async (req:express.Request, res:express.Response) => {
            const {body, from, to} = req.body
            try {
                const message = await this.twilioClient.messages
                    .create({
                        body,
                        from,
                        to
                    })
                res.json({result: message})
            } catch (err: any) {
                console.error('SMS API threw an error', err);
                res.status(err.status ? err.status : 400).send({ error: err });
            };
        })

        app.all("/choose-phone-number", async (req:express.Request, res:express.Response) => {
            try {
                const rawNumbers = await this.twilioClient.incomingPhoneNumbers
                    .list({ phoneNumber: req.body.phoneNumber, limit: 20 })
                const selectedNumber = reformatTwilioPns(rawNumbers, this.callerEmail)["phone-numbers"];

                // Should only have a single number
                if (selectedNumber.length === 1) {
                    // Motive: refuse to overwrite a number actively owned by another engineer.
                    // Slug-equality (not reconstructed-email equality) is the source of truth
                    // — `unslugEmail` can be lossy if the original email contained chars
                    // outside our token set.
                    const ownership = selectedNumber[0].ownership;
                    if (
                        ownership.state === 'taken' &&
                        ownership.ownerSlug &&
                        !ownership.isYou
                    ) {
                        const ownerLabel = ownership.ownerDisplay || ownership.ownerSlug;
                        console.warn(`Refused to steal ${selectedNumber[0].phoneNumber} from ${ownerLabel}`);
                        return res.status(409).json({
                            error: 'in_use_by',
                            owner: ownerLabel,
                            message: `In use by ${ownerLabel}. Pick a different number.`,
                        });
                    }

                    await removePhoneWebhooks(this.cliSettings.phoneNumber, this.twilioClient.incomingPhoneNumbers);
                    this.cliSettings.phoneNumber = selectedNumber[0];
                    this.cliSettings.phoneNumber = await updatePhoneWebhooks(this.cliSettings.phoneNumber,this.twilioClient.incomingPhoneNumbers, {voiceUrl: this.voiceUrl, smsUrl: this.smsUrl, statusCallback: this.statusCallback} );
                    res.json({
                        phoneNumber: this.cliSettings.phoneNumber,
                        message: 'Phone number updated!'
                    });
                } else {
                    console.error('Phone number not found!');
                    res.status(400).send({
                        message: 'Phone number not found!'
                    });
                }
            } catch (err) {
                console.error(err)
                res.status(400).send(err);
            }
        })

        app.get("/client-token", async (req:express.Request, res:express.Response) => {
            try {
                if (!this.jwt) {
                    this.jwt = await this.createJwt();
                }

                res.json({ token: this.jwt });
            } catch (err) {
                res.status(400).send(err)
            }
        })

        const isHeadless = () => !!this.flags.headless;

        app.listen(this.port, () => {
            console.log(`🚀 Your local webserver is listening on port ${this.port}`);

            if (fs.existsSync(path.join(WebClientPath, 'index.html'))) {

                const uiUrl = `http://localhost:${this.port}/`

                if (isHeadless()) {
                    console.log(`🌐 UI is available at ${uiUrl}`)
                } else {
                    console.log(`🌐 Opening ${uiUrl} your browser`);
                    open(uiUrl);
                }

            } else {
                console.log('Hello friend! Front end files are missing, ie you are developing this pluign.');
                console.log('Run: `cd plugin-dev-phone-client` then `npm start` to run dev front-end')
                console.log('To build the front-end so that the local backend will serve it: ./build-for-release.sh')
            }

            console.log('▶️  Use ctrl-c to stop your dev-phone\n');
        });
    }

    async createFunction() {
        console.log('💻 Deploying a Functions Service to handle incoming calls and SMS...');
        const deployedFunctions = await deployServerless({
            username: this.twilioClient.username,
            password: this.twilioClient.password,
            env: {
                SYNC_SERVICE_SID: this.sync.sid,
                CONVERSATION_SID: this.conversation.sid,
                CONVERSATION_SERVICE_SID: this.conversation.serviceSid,
                DEV_PHONE_NAME: this.devPhoneName,
                DEV_PHONE_VERSION: version,
                CALL_LOG_MAP_NAME
            },
            onUpdate: (event) => {
                const isBuildStatusPing = event.message.indexOf('Current status: building') > -1
                const settingEnvVars = event.message.indexOf('environment variables') > -1
                if(isBuildStatusPing || event.status === 'building') {
                    isBuildStatusPing ? process.stdout.write('.') : process.stdout.write(`🛠 ${event.message}`)
                } else {
                    console.log(`${settingEnvVars ? '\n' : ''}🧑‍💻 ${event.message}`)
                }
            }
        });

        console.log(`✅ I'm using the Serverless Service ${deployedFunctions.serviceSid}\n`);

        this.voiceUrl = `https://${deployedFunctions.domain}/${constants.INCOMING_CALL_HANDLER}`
        this.voiceOutboundUrl = `https://${deployedFunctions.domain}/${constants.OUTBOUND_CALL_HANDLER}`
        this.smsUrl = `https://${deployedFunctions.domain}/${constants.INCOMING_MESSAGE_HANDLER}`
        this.statusCallback = `https://${deployedFunctions.domain}/${constants.SYNC_CALL_HISTORY}`

        return deployedFunctions;
    }

    async destroyFunction() {
        try {
            const functionServices = await this.twilioClient.serverless.v1.services.list()
            const devPhoneFunctionServices = functionServices.filter((functionServices: ServerlessServiceInstance) => {
            return functionServices.friendlyName !== null && functionServices.friendlyName.startsWith(this.devPhoneName)
          })

          if(devPhoneFunctionServices.length > 0) {
              console.log(`🚮 Removing Serverless Functions for ${this.devPhoneName}`);

              for (const functionService of devPhoneFunctionServices) {
                await this.twilioClient.serverless.v1.services(functionService.sid)
                  .remove();
              }
          }
        } catch (err) {
            console.error(err)
        }
    }

    async destroyAllFunctions() {
        try {
            const functionServices = await this.twilioClient.serverless.v1.services.list()
            const devPhoneFunctionServices = functionServices.filter((functionServices: ServerlessServiceInstance) => {
            return functionServices.friendlyName !== null && functionServices.friendlyName.startsWith('dev-phone')
        })

        if(devPhoneFunctionServices.length > 0) {
            console.log(`🚮 Removing All Serverless Functions for existing dev phone`);
            for (const functionService of devPhoneFunctionServices) {
                await this.twilioClient.serverless.v1.services(functionService.sid)
                        .remove();
            }
        }
        } catch (err) {
            console.error(err)
        }
    }


    async validatePropsAndFlags(props: any, flags: any) {
        // Flags defined below can be validated and used here. Example:
        // https://github.com/twilio/plugin-debugger/blob/main/src/commands/debugger/logs/list.js#L46-L56

        this.cliSettings.forceMode = flags['force'];
        this.port = process.env.TWILIO_DEV_PHONE_PORT || await getAvailablePort();
        if (flags['phone-number']) {
            const phoneNumber = await flags['phone-number']
            this.pns = await this.twilioClient.incomingPhoneNumbers
                .list({ phoneNumber: phoneNumber });

            if (this.pns.length < 1) {
                throw new TwilioCliError(
                    `The phone number ${phoneNumber} is not associated with your Twilio account`
                );
            }

            const pnConfigAlreadySet = [
                (isSmsUrlSet(this.pns[0].smsUrl) ? "SMS webhook URL" : null),
                (isVoiceUrlSet(this.pns[0].voiceUrl) ? "Voice webhook URL" : null),
            ].filter(x => x);

            if (pnConfigAlreadySet.length > 0 && !this.cliSettings.forceMode) {
                throw new TwilioCliError(
                    `Cannot use ${phoneNumber} because the following config for that phone number would be overwritten: ` + pnConfigAlreadySet.join(", ")
                );
            }

            this.cliSettings.phoneNumber = reformatTwilioPns(this.pns, this.callerEmail)["phone-numbers"][0];

        }

        if(flags['port']) {
            const port = await flags['port']
            try {
                if(isValidPort(port)){
                    this.port = parseInt(port)
                } else {
                    throw new TwilioCliError(
                        `❗️ '${port}' is not a valid port. 😳 I'll try to get set up with ${this.port} instead.`,
                        )
                }
            } catch (err:any) {
                console.error(err.message)
            }
        }
    }

    twilioCliIsConfiguredWithApiKey() {
        return this.currentProfile.apiKey.startsWith("SK");
    }

    async reuseOrCreateApiKey() {

        // We need an API KEY and SECRET to create the Access Token
        // Depending on how the user has provided the CLI with creds
        // we may have one already in this.currentProfile, or we may
        // need to create a new one

        if (this.twilioCliIsConfiguredWithApiKey()) {
            // mtv-managed path: the Twilio CLI profile already has an API
            // key+secret (secret stored in the OS keychain). Reuse it so we
            // don't accumulate keys on every launch.

            console.log("✅ I'm using your profile API key.\n");
            return {
                sid: this.currentProfile.apiKey,
                secret: this.currentProfile.apiSecret
            }

        } else {
            // Fallback path: caller is using $TWILIO_ACCOUNT_SID and
            // $TWILIO_AUTH_TOKEN env vars without an API-key-backed CLI
            // profile. Create a per-run key and clean it up at shutdown
            // (destroyApiKeys) so the secret never lands on disk.

            const mask = (value: string): string => {
                if (!value) return "";
                const last4 = value.slice(-4);
                return `${"*".repeat(value.length - 4)}${last4}`;
            };

            console.log("💻 I'm creating a new API Key...");
            await this.destroyApiKeys();
            try {
                const key = await this.twilioClient.newKeys.create({ friendlyName: this.devPhoneName });
                console.log(`✅ I'm using the API Key ${mask(key.sid)}\n`);

                this.currentProfile.apiKey = key.sid;
                this.currentProfile.apiSecret = key.secret;
                return {
                    sid: key.sid,
                    secret: key.secret
                }
            } catch (err) {
                throw new TwilioCliError(
                    `Failed to create a Twilio API key for the dev-phone: ${(err as Error).message}\n` +
                    SUPPORT_FOOTER
                );
            }
        }
    }

    async destroyApiKeys() {
        if (this.twilioCliIsConfiguredWithApiKey()) {
            // CLI-profile path: the key is owned by the profile, not this run.
            return;
        }
        try {
            const keys = await this.twilioClient.keys.list()
            const devPhoneKeys = keys.filter((key: KeyInstance) => {
                return key.friendlyName !== null && key.friendlyName.startsWith(this.devPhoneName)
            })

            if (devPhoneKeys.length > 0) {
                console.log(`🚮 Removing API Keys for ${this.devPhoneName}`);
                for (const key of devPhoneKeys) {
                    await this.twilioClient.keys(key.sid).remove();
                }
            }
        } catch (err) {
            console.error(err)
        }
    }

    async destroyAllApiKeys() {

        if (this.twilioCliIsConfiguredWithApiKey()) {
            // we never created one
            return
        } else {
            try {
                const keys = await this.twilioClient.keys.list()
                const devPhoneKeys = keys.filter((key: KeyInstance) => {
                    return key.friendlyName !== null && key.friendlyName.startsWith('dev-phone')
                })

                if(devPhoneKeys.length > 0) {
                    console.log(`🚮 Removing All API Keys for existing dev phone`);
                    for (const key of devPhoneKeys) {
                        await this.twilioClient.keys(key.sid).remove();
                    }
                }
            } catch (err) {
                console.error(err)
            }
        }
    }

    async createTwimlApp() {
        console.log('💻 Creating a new TwiMl App to allow voice calls from your browser...');
        await this.destroyTwimlApps()
        try {
            const app = await this.twilioClient.applications
                .create({
                    voiceUrl: this.voiceOutboundUrl,
                    friendlyName: this.devPhoneName
                });
            console.log(`✅ I'm using the TwiMl App ${app.sid}\n`);
            return app;
        } catch (err) {
            console.error(err)
        }
    }

    async destroyTwimlApps() {
        try {
            const applications = await this.twilioClient.applications.list()
            const devPhoneApps = applications.filter((twimlApp: ApplicationInstance) => {
                return twimlApp.friendlyName !== null && twimlApp.friendlyName.startsWith(this.devPhoneName)
            })

            if(devPhoneApps.length > 0) {
                console.log(`🚮 Removing TwiML app for ${this.devPhoneName}`);
                for (const twimlApp of devPhoneApps) {
                    await this.twilioClient.applications(twimlApp.sid)
                        .remove();
                }
            }
        } catch (err) {
            console.error(err)
        }
    }

    async destroyAllTwimlApps() {
        try {
            const applications = await this.twilioClient.applications.list()
            const devPhoneApps = applications.filter((twimlApp: ApplicationInstance) => {
                return twimlApp.friendlyName !== null && twimlApp.friendlyName.startsWith('dev-phone')
            })

            if(devPhoneApps.length > 0) {
                console.log(`🚮 Removing All TwiML app for existing dev phone`);
                for (const twimlApp of devPhoneApps) {
                    await this.twilioClient.applications(twimlApp.sid)
                        .remove();
                }
            }
        } catch (err) {
            console.error(err)
        }
    }

    async createJwt() {

        const chatGrant = new ChatGrant({
            serviceSid: this.conversation.serviceSid
        });

        const voiceGrant = new VoiceGrant({
            incomingAllow: true,
            outgoingApplicationSid: this.twimlApp.sid
        });

        const syncGrant = new SyncGrant({
            serviceSid: this.sync.sid,
        })

        const token = new AccessToken(
            this.twilioClient.accountSid,
            this.apikey.sid,
            this.apikey.secret,
            {
                identity: this.devPhoneName,
                ttl: 24*60*60
            }
        );

        token.addGrant(chatGrant);
        token.addGrant(voiceGrant);
        token.addGrant(syncGrant);
        return token.toJwt();
    }

    async createSync() {
        console.log('💻 Creating a new sync list for call history...');
        await this.destroySyncs()

        try {
            const syncService = await this.twilioClient.sync.v1.services
                .create({ friendlyName: this.devPhoneName });
            console.log(`✅ I'm using the sync service ${syncService.sid}\n`);
            // create 'CallLog' syncMap
            await this.twilioClient.sync.v1.services(syncService.sid).syncMaps.create({
                uniqueName: CALL_LOG_MAP_NAME,
            });
            return syncService
        } catch (err) {
            console.error(err)
        }
    }

    async destroySyncs() {
        try {
            const syncServices = await this.twilioClient.sync.v1.services.list()
            const devPhoneSyncServices = syncServices.filter((syncService: SyncServiceInstance) => {
                return syncService.friendlyName !== null && syncService.friendlyName.startsWith(this.devPhoneName)
            })

            if(devPhoneSyncServices.length > 0) {
                console.log(`🚮 Removing Sync Service for ${this.devPhoneName}`);
                for (const syncService of devPhoneSyncServices) {
                    await this.twilioClient.sync.v1.services(syncService.sid)
                            .remove();
                }
            }
        } catch (err) {
            console.error(err)
        }
    }

    async destroyAllSyncs() {
        try {
            const syncServices = await this.twilioClient.sync.v1.services.list()
            const devPhoneSyncServices = syncServices.filter((syncService: SyncServiceInstance) => {
                return syncService.friendlyName !== null && syncService.friendlyName.startsWith('dev-phone')
            })

            if(devPhoneSyncServices.length > 0) {
                console.log(`🚮 Removing All Sync Service for existing dev phone`);
                for (const syncService of devPhoneSyncServices) {
                    await this.twilioClient.sync.v1.services(syncService.sid)
                            .remove();
                }
            }
        } catch (err) {
            console.error(err)
        }
    }

    // Creates a new conversation service, a conversation, and makes the dev phone a participant
    async createConversation() {
        await this.destroyConversations()
        console.log('💻 Creating a new conversation...');
        try {
            const service = await this.twilioClient.conversations.v1.services
                .create({ friendlyName: this.devPhoneName });
            const conversationService = this.twilioClient.conversations.v1.services(service.sid)
            const newConversation = await conversationService.conversations.create({ friendlyName: this.devPhoneName })
            await conversationService.conversations(newConversation.sid)
                .participants.create({identity: this.devPhoneName})
            console.log(`✅ I'm using the conversation ${newConversation.sid} from service ${service.sid}\n`);
            return {
                serviceSid: service.sid,
                sid: newConversation.sid
            }
        } catch (err) {
            console.error(err)
        }
    }

    async destroyConversations() {
        try {
            const convoServices = await this.twilioClient.conversations.v1.services.list()
            const devPhoneConvoServices = convoServices.filter((convoService: SyncServiceInstance) => {
                return convoService.friendlyName !== null && convoService.friendlyName.startsWith(this.devPhoneName)
            })

            if(devPhoneConvoServices.length > 0) {
                console.log(`🚮 Removing Conversation Service for ${this.devPhoneName}`);
                for (const convoService of devPhoneConvoServices) {
                    await this.twilioClient.conversations.v1.services(convoService.sid)
                            .remove();
                }
            }
        } catch (err) {
            console.error(err)
        }
    }

    async destroyAllConversations() {
        try {
            const convoServices = await this.twilioClient.conversations.v1.services.list()
            const devPhoneConvoServices = convoServices.filter((convoService: SyncServiceInstance) => {
                return convoService.friendlyName !== null && convoService.friendlyName.startsWith('dev-phone')
            })

            if(devPhoneConvoServices.length > 0) {
                console.log(`🚮 Removing All Conversation Service for existing dev phone`);
                for (const convoService of devPhoneConvoServices) {
                    await this.twilioClient.conversations.v1.services(convoService.sid)
                            .remove();
                }
            }
        } catch (err) {
            console.error(err)
        }
    }

    async removeAllPhoneWebhooks() {
        try {
            const pns = await this.twilioClient.incomingPhoneNumbers.list()

            const numbersDevPhone = pns.filter((pn: IncomingPhoneNumberInstance) => {
              return pn.smsUrl.startsWith('https://dev-phone') && pn.voiceUrl.startsWith('https://dev-phone')
            });

            if (numbersDevPhone.length > 0) {
              console.log(`🚮 Removing All number webhooks for dev phone`);
              for (const pn of numbersDevPhone) {
                await removePhoneWebhooks({
                  voiceUrl: '',
                  smsUrl: '',
                  statusCallback: '',
                  phoneNumber: pn.phoneNumber,
                  sid: pn.sid,
                }, this.twilioClient.incomingPhoneNumbers);
              }
            }
        } catch (err) {
            console.error(err)
        }
    }
}

DevPhoneServer.description = `Dev Phone local express server`

// Example of how to define flags and properties:
// https://github.com/twilio/plugin-debugger/blob/main/src/commands/debugger/logs/list.js#L99-L126
DevPhoneServer.PropertyFlags = {
    "phone-number": Flags.string({
        description: 'Optional. Associates the Dev Phone with a phone number. Takes a number from the active profile on the Twilio CLI as the parameter.'
    }),
    force: Flags.boolean({
        char: 'f',
        description: 'Optional. Forces an overwrite of the phone number configuration.',
        dependsOn: ['phone-number']
    }),
    headless: Flags.boolean({
        description: 'Optional. Prevents the UI from automatically opening in the browser.',
        default: false,
    }),
    clear: Flags.boolean({
        description: 'Optional. Remove all dev-phone resources from your account before starting the dev-phone.',
        default: false,
    }),
    port: Flags.string({
        description: 'Optional. Configures the port of the Dev Phone UI. Takes a valid port as a parameter.',
    })
};

DevPhoneServer.flags = Object.assign(
    DevPhoneServer.PropertyFlags,
    TwilioClientCommand.flags
);

module.exports = DevPhoneServer;
