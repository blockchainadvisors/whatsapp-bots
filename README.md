# WhatsApp Translate Bot

Node.js bot built on top of [`@whiskeysockets/baileys`](https://github.com/WhiskeySockets/Baileys). It translates or transcribes incoming WhatsApp messages on demand using OpenAI models, persists task state in SQLite, and supports multi-device login.

---

## 1. Requirements
- **Node.js 20** (matches the version used in production: `v20.19.2`).
- **npm 9+** (bundled with Node 20).
- **FFmpeg** with `ffprobe` (required for audio/video transcription via `fluent-ffmpeg`).
  - Ubuntu/Debian: `sudo apt install ffmpeg`
  - macOS (Homebrew): `brew install ffmpeg`
- An **OpenAI API key** that has access to both text translation (or GPT) and speech-to-text (Whisper) endpoints.

> Tip: confirm `ffmpeg` availability with `ffmpeg -version` and `ffprobe -version`.

---

## 2. Installation
1. **Clone the repository** (or copy the project directory to your machine).
2. **Install dependencies**:
   ```bash
   npm install
   ```
3. (Optional) **Build TypeScript output** if you plan to run with `npm start`:
   ```bash
   npm run build
   ```

---

## 3. Configuration
1. Duplicate the sample environment file and fill in secrets:
   ```bash
   cp .env.sample .env
   ```
2. Edit `.env`:
   - `SOURCE_LANG` – default language expected when converting speech to text (used when `/stt` is issued without an override).
   - `TARGET_LANG` – fallback translation target for `/translate`.
   - `OPENAI_API_KEY` – used for text translation requests.
   - `OPENAI_API_KEY_FOR_STT` – used for Whisper speech-to-text (`transcribeAudio`).
   - Optional overrides:
     - `OPENAI_AUDIO_MODEL` – defaults to `whisper-1`.
3. **Persisted state**:
   - Authentication credentials are stored under the `auth/` directory. Delete this folder to force a fresh login.
   - Translation/transcription task cache lives in `tasks.db` (SQLite). It is created automatically.

---

## 4. Running the Bot

### Development (recommended while iterating)
```bash
npm run dev
```
This uses `ts-node` to execute `src/index.ts` directly. Logs print to the terminal including QR prompts.

### Production / background process (PM2)
```bash
pm2 start npm --name dev-whatsapp-bot -- run dev
pm2 logs dev-whatsapp-bot --lines 100
```
Use `pm2 restart dev-whatsapp-bot` after configuration changes, and `pm2 stop dev-whatsapp-bot` to halt the bot.

---

## 5. WhatsApp Authentication (QR Pairing)
Baileys uses WhatsApp Web multi-device sessions. Follow these steps whenever you deploy to a new machine or the session expires:

1. **Stop the bot** (if running):
   ```bash
   pm2 stop dev-whatsapp-bot   # or press Ctrl+C if using npm run dev
   ```
2. **Remove existing credentials** to force a fresh QR code:
   ```bash
   rm -rf auth
   ```
3. **Start the bot**:
   ```bash
   npm run dev
   # or: pm2 start dev-whatsapp-bot
   ```
4. Watch the console/logs. You will see:
   ```
   📱 Scan this QR to log in:
   ██████...
   ```
   - The QR also saves to `QR.png` in the project root for convenience.
5. **On your phone**: open WhatsApp → *Linked devices* → *Link a device*, then scan the QR code.
6. Once paired, the logs show `✅ Connected to WhatsApp`. Credentials are stored under `auth/`; do not delete this folder unless you need to re-link.

---

## 6. Commands & Features
- `/translate`, `/tr`: translate the message or replied-to text. Suffix with `/LANG` (e.g., `/translate/en`) to force the target language. Use `/translate/private/en` to respond privately.
- `/stt`, `/speechtotext`, `/totext`: transcribe the quoted voice/video message. Append `/LANG` to control transcription language.
- Task results are cached in `tasks.db`, so repeated requests reuse previous translations/transcriptions when possible.
- Any message type the bot cannot decode logs as `⚠️ Skipping undecryptable or unsupported message`; this is expected for stickers, encrypted events, etc.

---

## 7. Troubleshooting
- **QR never appears**: ensure `auth/` is deleted before restarting and check `pm2 logs` for `connection.update` status codes. A `401` implies the device is logged out; `428/515` often resolve after a fresh start.
- **Bad MAC / undecryptable messages**: usually indicates stale sessions. Delete `auth/`, re-link, and ensure the phone remains online.
- **Transcription failures**: confirm FFmpeg is installed and `OPENAI_API_KEY_FOR_STT` has Whisper access.
- **SQLite locking**: if using a shared volume, ensure only one instance of the bot writes to `tasks.db`.

---

## 8. Useful PM2 Commands
- `pm2 ls` – list managed processes.
- `pm2 logs dev-whatsapp-bot --lines 100` – live log tail.
- `pm2 restart dev-whatsapp-bot` – apply changes.
- `pm2 stop dev-whatsapp-bot` / `pm2 delete dev-whatsapp-bot` – stop/remove process definition.

---

Happy translating! Reach out to [Baileys documentation](https://github.com/WhiskeySockets/Baileys#readme) for advanced configuration like proxy support or webhooks.
