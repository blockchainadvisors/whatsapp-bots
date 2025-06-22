import * as baileys from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import * as dotenv from 'dotenv';
import pino from 'pino';
import { translateText } from './translator.js';
import qrcode from 'qrcode-terminal';
import * as QRCode from 'qrcode';
import * as fs from 'fs';

const { makeWASocket, useMultiFileAuthState, DisconnectReason } = baileys;

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
                const text = msg.message?.conversation || msg.message?.extendedTextMessage?.text;
                if (!text) {
                    console.warn('⚠️ Skipping undecryptable or unsupported message');
                    continue;
                }

                const sender = msg.key.remoteJid;
                if (!sender || !text.startsWith('/translate ')) return;

                const query = text.replace('/translate ', '').trim();
                if (!query) return;

                const translated = await translateText(query);
                await sock.sendMessage(sender, { text: `🌍 ${translated}` }, { quoted: msg });

            } catch (err) {
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
