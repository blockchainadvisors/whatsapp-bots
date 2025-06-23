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

async function startBot() {
    console.log('Starting the app');
    await initDB();
    console.log('Database initialized');
    const { state, saveCreds } = await useMultiFileAuthState('./auth');
    const sock = makeWASocket({
        auth: state,
        logger: pino({ level: 'silent' }) // optional: silence extra logs
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

                // 🔊 Speech-to-Text
                const sttMatch = rawText.match(/^\/stt(?:\/(\w{2}))?/);
                if (sttMatch) {
                    console.log('🟡 Received /stt command');

                    const langCode = sttMatch[1] || process.env.SOURCE_LANG || 'ro';
                    const isReply = !!msg.message?.extendedTextMessage?.contextInfo?.quotedMessage;
                    const taskId = isReply
                        ? msg.message?.extendedTextMessage?.contextInfo?.stanzaId
                        : msg.key.id;

                    if (!taskId) {
                        console.warn('⚠️ Message ID is missing, skipping STT task');
                        continue;
                    }

                    const existing = await getTaskStatus(taskId, 'stt', langCode);
                    if (existing?.status === 'done') {
                        console.log(`✅ Reusing cached transcription for ${taskId} (${langCode})`);
                        await sock.sendMessage(sender, { text: `🗣️ ${existing.result}` }, { quoted: msg });
                        continue;
                    }
                    if (existing?.status === 'processing') {
                        console.log(`⚠️ Already processing STT task ${taskId} (${langCode})`);
                        continue;
                    }

                    await markTaskProcessing(taskId, 'stt', langCode);

                    const contextInfo = msg.message?.extendedTextMessage?.contextInfo;
                    const quoted = contextInfo?.quotedMessage;

                    if (!quoted) {
                        console.warn('⚠️ No quoted message found for /stt');
                        await sock.sendMessage(sender, { text: '⚠️ Please reply to a voice message with /stt' }, { quoted: msg });
                        continue;
                    }

                    console.log('📎 Quoted message type:', Object.keys(quoted));
                    const mediaMsg = quoted.audioMessage || quoted.videoMessage;
                    const mediaType = quoted.audioMessage ? 'audioMessage' : quoted.videoMessage ? 'videoMessage' : null;

                    if (!mediaMsg || !mediaMsg.mediaKey || !mediaType) {
                        console.error('❌ Audio/video message is invalid or missing mediaKey');
                        await sock.sendMessage(sender, { text: '⚠️ Invalid or corrupt audio/video message.' }, { quoted: msg });
                        continue;
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
                        await sock.sendMessage(sender, { text: `🗣️ ${transcript}` }, { quoted: msg });
                        await markTaskDone(taskId, 'stt', langCode, transcript);
                    } catch (err) {
                        console.error('❌ Transcription failed:', err);
                        await sock.sendMessage(sender, { text: '⚠️ Failed to transcribe audio/video message.' }, { quoted: msg });
                        await markTaskFailed(taskId);
                    } finally {
                        if (filename && fs.existsSync(filename)) {
                            fs.unlinkSync(filename);
                        }
                    }

                    continue;
                }

                // 🌍 Translation
                if (!sender || !rawText.startsWith('/translate')) return;

                console.log('🟡 Received /translate command');

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
                    query = rawText.replace(/^\/translate(\/\w{2})?\s*/, '').trim();
                }


                if (!query) {
                    console.warn('⚠️ No text found to translate.');
                    continue;
                }

                const langOverrideMatch = rawText.match(/^\/translate\/(\w{2})/);
                const overrideLang = langOverrideMatch?.[1]?.toLowerCase() || 'auto';

                const taskId = isReply
                    ? msg.message?.extendedTextMessage?.contextInfo?.stanzaId
                    : msg.key.id;

                if (!taskId) {
                    console.warn('⚠️ Message ID is missing, skipping translation task');
                    continue;
                }

                const existing = await getTaskStatus(taskId, 'translate', overrideLang);
                if (existing?.status === 'done') {
                    console.log(`✅ Reusing cached translation for ${taskId} (${overrideLang})`);
                    await sock.sendMessage(sender, { text: existing.result ?? '' }, { quoted: msg });
                    continue;
                }
                if (existing?.status === 'processing') {
                    console.log(`⚠️ Already processing translation task ${taskId} (${overrideLang})`);
                    continue;
                }

                await markTaskProcessing(taskId, 'translate', overrideLang);

                try {
                    const translated = overrideLang === 'auto'
                        ? await translateTextAuto(query)
                        : await translateTextTo(query, overrideLang);

                    await sock.sendMessage(sender, { text: translated }, { quoted: msg });
                    await markTaskDone(taskId, 'translate', overrideLang, translated);

                } catch (err) {
                    console.error('❌ Translation failed:', err);
                    await sock.sendMessage(sender, { text: '⚠️ Failed to translate the message.' }, { quoted: msg });
                    await markTaskFailed(taskId);
                }
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

    sock.ev.on('connection.update', ({ connection, lastDisconnect, qr }) => {
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
        }
    });
}

startBot();
