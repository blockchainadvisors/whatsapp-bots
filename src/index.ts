//src/index.ts
import * as baileys from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import * as dotenv from 'dotenv';
import pino from 'pino';
import { translateTextAuto, translateTextTo } from './translator.js';
import { transcribeAudio } from './audioTranscriber.js';
import qrcode from 'qrcode-terminal';
import * as QRCode from 'qrcode';
import * as fs from 'fs';
import mime from 'mime-types'; // ensure this is installed

const { makeWASocket, useMultiFileAuthState, DisconnectReason, downloadMediaMessage } = baileys;

dotenv.config();

async function startBot() {
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

                    const contextInfo = msg.message?.extendedTextMessage?.contextInfo;
                    const quoted = contextInfo?.quotedMessage;

                    if (!quoted) {
                        console.warn('⚠️ No quoted message found for /stt');
                        await sock.sendMessage(sender, { text: '⚠️ Please reply to a voice message with /stt' }, { quoted: msg });
                        continue;
                    }

                    console.log('📎 Quoted message type:', Object.keys(quoted));
                    const audioMsg = quoted.audioMessage;
                    if (!audioMsg || !audioMsg.mediaKey) {
                        console.error('❌ Audio message is invalid or missing mediaKey');
                        await sock.sendMessage(sender, { text: '⚠️ Invalid or corrupt audio message.' }, { quoted: msg });
                        continue;
                    }

                    let filename: string | null = null;
                    try {
                        const buffer = await downloadMediaMessage(
                            { message: { audioMessage: audioMsg } } as any,
                            'buffer',
                            {}
                        );
                        const mimetype = audioMsg.mimetype ?? undefined;
                        const extension = mimetype ? mime.extension(mimetype) || 'ogg' : 'ogg';
                        filename = `./audio-${Date.now()}.${extension}`;
                        fs.writeFileSync(filename, buffer);

                        const transcript = await transcribeAudio(filename, langCode);
                        await sock.sendMessage(sender, { text: `🗣️ ${transcript}` }, { quoted: msg });
                    } catch (err) {
                        console.error('❌ Transcription failed:', err);
                        await sock.sendMessage(sender, { text: '⚠️ Failed to transcribe audio message.' }, { quoted: msg });
                    } finally {
                        if (filename && fs.existsSync(filename)) {
                            fs.unlinkSync(filename);
                        }
                    }

                    continue;
                }

                // 🌍 Translation
                if (!sender || !rawText.startsWith('/translate')) return;

                const isReply = !!msg.message?.extendedTextMessage?.contextInfo?.quotedMessage;
                const query = isReply
                    ? msg.message?.extendedTextMessage?.contextInfo?.quotedMessage?.conversation
                    : rawText.replace(/^\/translate(\s+\w+)?\s*/, '').trim();

                if (!query) continue;

                const langOverrideMatch = rawText.match(/^\/translate\/(\w{2})/);
                const overrideLang = langOverrideMatch?.[1]?.toLowerCase();

                const translated = overrideLang
                    ? await translateTextTo(query, overrideLang)
                    : await translateTextAuto(query);
                await sock.sendMessage(sender, { text: `${translated}` }, { quoted: msg });

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
            const shouldReconnect = (lastDisconnect?.error as Boom)?.output?.statusCode !== DisconnectReason.loggedOut;
            if (shouldReconnect) startBot();
        }

        if (connection === 'open') {
            console.log('✅ Connected to WhatsApp');
        }
    });
}

startBot();
