// src/audioTranscriber.ts
import { OpenAI } from 'openai';
import * as fs from 'fs';
import * as path from 'path';
import ffmpeg from 'fluent-ffmpeg';
import * as dotenv from 'dotenv';
dotenv.config();

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY_FOR_STT });

export async function transcribeAudio(inputPath: string, lang: string): Promise<string> {
    const CHUNK_DURATION = 240; // seconds
    const tempDir = path.join(process.cwd(), 'chunks_' + Date.now());
    fs.mkdirSync(tempDir);

    const audioPath = path.join(tempDir, 'audio.mp3');

    try {
        // 🔈 Extract full audio from input (video or audio file)
        await new Promise<void>((resolve, reject) => {
            ffmpeg(inputPath)
                .noVideo()
                .audioCodec('libmp3lame')
                .output(audioPath)
                .on('end', () => resolve())
                .on('error', reject)
                .run();
        });

        // 🕒 Get duration of the extracted audio
        const getDuration = (): Promise<number> =>
            new Promise((resolve, reject) => {
                ffmpeg.ffprobe(audioPath, (err, metadata) =>
                    err ? reject(err) : resolve(metadata.format.duration ?? 0)
                );
            });

        const duration = await getDuration();
        const chunkPaths: string[] = [];

        for (let i = 0; i < Math.ceil(duration / CHUNK_DURATION); i++) {
            const chunkPath = path.join(tempDir, `chunk${i}.mp3`);
            await new Promise<void>((resolve, reject) => {
                ffmpeg(audioPath)
                    .setStartTime(i * CHUNK_DURATION)
                    .duration(CHUNK_DURATION)
                    .output(chunkPath)
                    .on('end', () => resolve())
                    .on('error', reject)
                    .run();
            });
            chunkPaths.push(chunkPath);
        }

        // 🧠 Transcribe each audio chunk
        const transcripts = [];
        for (const chunk of chunkPaths) {
            const file = fs.createReadStream(chunk);
            const result = await openai.audio.transcriptions.create({
                file,
                model: process.env.OPENAI_AUDIO_MODEL || 'whisper-1',
                language: lang
            });
            transcripts.push(result.text);
        }

        return transcripts.join('\n\n');
    } finally {
        if (fs.existsSync(tempDir)) fs.rmSync(tempDir, { recursive: true, force: true });
        if (fs.existsSync(inputPath)) fs.unlinkSync(inputPath);
    }
}
