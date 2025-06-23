// src/audioTranscriber.ts
import { OpenAI } from 'openai';
import * as fs from 'fs';
import * as dotenv from 'dotenv';
dotenv.config();

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY_FOR_STT });

export async function transcribeAudio(filePath: string, language: string): Promise<string> {
    const file = fs.createReadStream(filePath);
    const response = await openai.audio.transcriptions.create({
        file,
        model: process.env.OPENAI_AUDIO_MODEL || 'whisper-1',
        language
    });
    return response.text;
}