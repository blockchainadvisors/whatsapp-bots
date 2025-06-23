//src/translator.ts
import { OpenAI } from 'openai';
import * as dotenv from 'dotenv';
dotenv.config();

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

export async function translateTextAuto(text: string): Promise<string> {
  const sourceLang = process.env.SOURCE_LANG!;
  const targetLang = process.env.TARGET_LANG!;

  // Step 1: detect language
  const detectPrompt = `Detect the language of the following text and respond with only its ISO 639-1 code (e.g. ro, de, en):\n\n"${text}"`;

  const detectResp = await openai.chat.completions.create({
    model: 'gpt-4.1-nano',
    messages: [{ role: 'user', content: detectPrompt }],
    temperature: 0
  });

  const detected = detectResp.choices?.[0]?.message?.content?.trim().toLowerCase();

  const direction =
    detected === sourceLang.toLowerCase()
      ? `from ${sourceLang} to ${targetLang}`
      : `from ${detected} to ${sourceLang}`;

  const translatePrompt = `Translate this ${direction}:\n\n"${text}"`;

  const translateResp = await openai.chat.completions.create({
    model: 'gpt-4.1-nano',
    messages: [
      { role: 'system', content: 'You are a helpful translation assistant.' },
      { role: 'user', content: translatePrompt }
    ],
    temperature: 0.3
  });

  return translateResp.choices?.[0]?.message?.content?.trim() ?? '';
}

export async function translateTextTo(text: string, targetLang: string): Promise<string> {
  const detectPrompt = `Detect the language of the following text and respond with only its ISO 639-1 code:\n\n"${text}"`;

  const detectResp = await openai.chat.completions.create({
    model: 'gpt-4.1-nano',
    messages: [{ role: 'user', content: detectPrompt }],
    temperature: 0
  });

  const detected = detectResp.choices?.[0]?.message?.content?.trim().toLowerCase();
  const translatePrompt = `Translate this from ${detected} to ${targetLang}:\n\n"${text}"`;

  const translateResp = await openai.chat.completions.create({
    model: 'gpt-4.1-nano',
    messages: [
      { role: 'system', content: 'You are a helpful translation assistant.' },
      { role: 'user', content: translatePrompt }
    ],
    temperature: 0.3
  });

  return translateResp.choices?.[0]?.message?.content?.trim() ?? '';
}

