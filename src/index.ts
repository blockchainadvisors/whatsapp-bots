//src/index.ts
import * as baileys from '@whiskeysockets/baileys';
import { isBoom } from '@hapi/boom';
import * as dotenv from 'dotenv';
import pino from 'pino';
import { translateTextAuto, translateTextTo } from './translator.js';
import { transcribeAudio } from './audioTranscriber.js';
import qrcode from 'qrcode-terminal';
import * as QRCode from 'qrcode';
import * as fs from 'fs';
import mime from 'mime-types'; // ensure this is installed
import {
    initDB,
    getTaskStatus,
    markTaskProcessing,
    markTaskDone,
    markTaskFailed
} from './db.js';

const { makeWASocket, useMultiFileAuthState, DisconnectReason, downloadMediaMessage } = baileys;

dotenv.config();

function parseCommand(raw: string, prefix: string, fallbackLang = 'auto') {
    const match = raw.match(new RegExp(`^\\/${prefix}(?:\\/(\\w+))?(?:\\/(\\w+))?`, 'i'));
    const [first, second] = [match?.[1], match?.[2]];
    const lang = [first, second].find(x => x && x !== 'private') || fallbackLang;
    const isPrivate = [first, second].includes('private');

    console.log(`🔍 parseCommand | raw="${raw}" → lang="${lang}" | isPrivate=${isPrivate}`);

    return { lang, isPrivate };
}

async function handleTranslationCommand(sock: ReturnType<typeof makeWASocket>, msg: baileys.proto.IWebMessageInfo, rawText: string, prefix: string) {
    const { lang: overrideLang, isPrivate } = parseCommand(rawText, prefix, 'auto');
    const isReply = !!msg.message?.extendedTextMessage?.contextInfo?.quotedMessage;

    let query: string | undefined;
    if (isReply) {
        const quotedMsg = msg.message?.extendedTextMessage?.contextInfo?.quotedMessage;
        query =
            quotedMsg?.conversation ??
            quotedMsg?.extendedTextMessage?.text ??
            quotedMsg?.imageMessage?.caption ??
            quotedMsg?.videoMessage?.caption ??
            quotedMsg?.documentMessage?.caption ??
            undefined;
    } else {
        query = rawText
            .replace(new RegExp(`^\\/${prefix}(?:\\/\\w+)?(?:\\/\\w+)?`, 'i'), '')
            .trim();
    }

    if (!query) {
        console.warn('⚠️ No text found to translate.');
        return;
    }

    const taskId = isReply
        ? msg.message?.extendedTextMessage?.contextInfo?.stanzaId
        : msg.key.id;
    if (!taskId) {
        console.warn('⚠️ Message ID is missing, skipping translation task');
        return;
    }

    const messageAuthor = msg.key.participant || msg.participant || msg.key.remoteJid;
    const realUserJid = messageAuthor?.replace('@lid', '@s.whatsapp.net');
    const replyTarget = isPrivate ? realUserJid : msg.key.remoteJid;

    if (!replyTarget) {
        console.warn('⚠️ Could not determine a valid recipient JID for private reply. Skipping...');
        return;
    }

    try {
        const existing = await getTaskStatus(taskId, 'translate', overrideLang);
        if (existing?.status === 'done') {
            console.log(`✅ Reusing cached translation for ${taskId} (${overrideLang})`);
            await sock.sendMessage(replyTarget, { text: existing.result ?? '' }, isPrivate ? {} : { quoted: msg });
            return;
        }
        if (existing?.status === 'processing') {
            console.log(`⚠️ Already processing translation task ${taskId} (${overrideLang})`);
            return;
        }

        await markTaskProcessing(taskId, 'translate', overrideLang);

        const translated = overrideLang === 'auto'
            ? await translateTextAuto(query)
            : await translateTextTo(query, overrideLang);

        await sock.sendMessage(replyTarget, { text: translated }, isPrivate ? {} : { quoted: msg });
        await markTaskDone(taskId, 'translate', overrideLang, translated);

    } catch (err) {
        console.error('❌ Translation failed:', err);
        await sock.sendMessage(replyTarget, {
            text: '⚠️ Failed to translate the message.'
        }, isPrivate ? {} : { quoted: msg });

        await markTaskFailed(taskId);
    }
}

async function handleSttCommand(sock: ReturnType<typeof makeWASocket>, msg: baileys.proto.IWebMessageInfo, rawText: string, prefix: string) {
    const { lang: langCode, isPrivate } = parseCommand(rawText, prefix, process.env.SOURCE_LANG || 'ro');
    const isReply = !!msg.message?.extendedTextMessage?.contextInfo?.quotedMessage;
    const taskId = isReply
        ? msg.message?.extendedTextMessage?.contextInfo?.stanzaId
        : msg.key.id;

    const messageAuthor = msg.key.participant || msg.participant || msg.key.remoteJid;
    const realUserJid = messageAuthor?.replace('@lid', '@s.whatsapp.net');
    const replyTarget = isPrivate ? realUserJid : msg.key.remoteJid;

    console.log(`🧾 Computed replyTarget = ${replyTarget} | isPrivate=${isPrivate}`);

    if (!replyTarget) {
        console.warn('⚠️ No valid reply target found');
        return;
    }
    if (!taskId) {
        console.warn('⚠️ Message ID is missing, skipping STT task');
        return;
    }

    const existing = await getTaskStatus(taskId, 'stt', langCode);
    if (existing?.status === 'done') {
        console.log(`✅ Reusing cached transcription for ${taskId} (${langCode})`);
        await sock.sendMessage(replyTarget, { text: `🗣️ ${existing.result}` }, isPrivate ? {} : { quoted: msg });
        return;
    }
    if (existing?.status === 'processing') {
        console.log(`⚠️ Already processing STT task ${taskId} (${langCode})`);
        return;
    }

    await markTaskProcessing(taskId, 'stt', langCode);

    const quoted: any = msg.message?.extendedTextMessage?.contextInfo?.quotedMessage;
    // console.log('📦 DEBUG: quotedMessage structure →');
    // console.dir(quoted, { depth: 6 });

    // Try all known locations
    const layers = [
        { source: 'quoted', node: quoted },
        { source: 'quoted.message', node: quoted?.message },
        { source: 'quoted.documentWithCaptionMessage.message', node: quoted?.documentWithCaptionMessage?.message },
    ];

    let mediaMsg: any = null;
    let mediaType: 'audioMessage' | 'videoMessage' | 'documentMessage' | null = null;

    for (const { source, node } of layers) {
        const mimetype = node?.documentMessage?.mimetype ?? '';
        const isAudioDoc = mimetype.startsWith('audio/');
        const isVideoDoc = mimetype.startsWith('video/');

        if (node?.audioMessage?.mediaKey) {
            console.log(`✅ Found audioMessage at ${source}`);
            mediaMsg = node.audioMessage;
            mediaType = 'audioMessage';
            break;
        }
        if (node?.videoMessage?.mediaKey) {
            console.log(`✅ Found videoMessage at ${source}`);
            mediaMsg = node.videoMessage;
            mediaType = 'videoMessage';
            break;
        }
        if (node?.documentMessage?.mediaKey && (isAudioDoc || isVideoDoc)) {
            console.log(`✅ Found documentMessage (${mimetype}) at ${source}`);
            mediaMsg = node.documentMessage;
            mediaType = 'documentMessage';
            break;
        }

        console.log(`❌ No media found at ${source}`);
    }

    if (!mediaMsg || !mediaType) {
        await sock.sendMessage(replyTarget, {
            text: '⚠️ Please reply to a valid voice or video message. Text-only or unsupported messages will be ignored.'
        }, isPrivate ? {} : { quoted: msg });
        await markTaskFailed(taskId);
        return;
    }


    let filename: string | null = null;
    try {
        const buffer = await downloadMediaMessage(
            { message: { [mediaType]: mediaMsg } } as any,
            'buffer',
            {}
        );
        const mimetype = mediaMsg.mimetype ?? undefined;
        const extension = mimetype ? mime.extension(mimetype) || 'ogg' : 'ogg';
        filename = `./media-${Date.now()}.${extension}`;
        fs.writeFileSync(filename, buffer);

        const transcript = await transcribeAudio(filename, langCode);
        await sock.sendMessage(replyTarget, { text: `🗣️ ${transcript}` }, isPrivate ? {} : { quoted: msg });
        await markTaskDone(taskId, 'stt', langCode, transcript);
    } catch (err) {
        console.error('❌ STT failed:', err);
        await sock.sendMessage(replyTarget, { text: '⚠️ Failed to transcribe audio/video message.' }, isPrivate ? {} : { quoted: msg });
        await markTaskFailed(taskId);
    } finally {
        if (filename && fs.existsSync(filename)) {
            fs.unlinkSync(filename);
        }
    }
}

async function startBot() {
    console.log('Starting the app');
    await initDB();
    console.log('Database initialized');
    const { state, saveCreds } = await useMultiFileAuthState('./auth');
    const sock = makeWASocket({
        auth: state,
        logger: pino({ level: 'silent' })
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        if (type !== 'notify') return;

        for (const msg of messages) {
            try {
                const rawText =
                    msg.message?.conversation ||
                    msg.message?.extendedTextMessage?.text ||
                    msg.message?.extendedTextMessage?.contextInfo?.quotedMessage?.conversation;

                if (!rawText) {
                    console.warn('⚠️ Skipping undecryptable or unsupported message');
                    continue;
                }

                const sender = msg.key.remoteJid;
                if (!sender) continue;

                // 🔊 Speech-to-Text (supports /stt and /speech)
                const sttPrefixes = ['stt', 'speechtotext', 'totext'];
                const usedSttPrefix = sttPrefixes.find(p => rawText.startsWith(`/${p}`));
                if (usedSttPrefix) {
                    console.log(`🟡 Received /${usedSttPrefix} command`);
                    await handleSttCommand(sock, msg, rawText, usedSttPrefix);
                    continue;
                }

                // 🌍 Translation (supports /translate and /tr)
                const translationPrefixes = ['translate', 'tr'];
                const usedPrefix = translationPrefixes.find(p => rawText.startsWith(`/${p}`));
                if (!sender || !usedPrefix) return;

                console.log(`🟡 Received /${usedPrefix} command`);

                await handleTranslationCommand(sock, msg, rawText, usedPrefix);

            } catch (err) {
                if (err instanceof Error && err.message.includes('Bad MAC')) {
                    console.warn('⚠️ Signal session error (expected):', err.message);
                } else {
                    console.error('❌ Error handling message:', err);
                }
                console.error('❌ Error handling message:', err);
                const fallbackTarget = msg.key.remoteJid;
                if (fallbackTarget) {
                    await sock.sendMessage(fallbackTarget, {
                        text: '⚠️ Sorry, something went wrong during translation.'
                    });
                }
            }
        }
    });

    sock.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {
        if (qr) {
            console.log('📱 Scan this QR to log in:');
            qrcode.generate(qr, { small: true }); // terminal output

            QRCode.toFile('QR.png', qr, {
                width: 300,
                margin: 1
            }, (err) => {
                if (err) console.error('❌ Failed to save QR.png:', err);
                else console.log('✅ QR code saved to QR.png');
            });
        }

        if (connection === 'close') {
            const shouldReconnect =
                isBoom(lastDisconnect?.error) &&
                lastDisconnect.error.output.statusCode !== DisconnectReason.loggedOut; if (shouldReconnect) startBot();
        }

        if (connection === 'open') {
            console.log('✅ Connected to WhatsApp');
            // Set profile name and status once connection is open
            // try {
            //     await sock.updateProfileName('I Robot');
            //     await sock.updateProfileStatus('🤖 Your friendly translation assistant');
            //     console.log('✅ Profile updated');
            // } catch (err) {
            //     console.warn('⚠️ Failed to update profile:', err);
            // }
        }
    });
}

startBot();