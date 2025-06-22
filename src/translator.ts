import { OpenAI } from "openai";
import * as dotenv from "dotenv";
dotenv.config();

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

type Msg = { role: "user"; content: string };

export async function translateText(text: string, targetLang = process.env.DEFAULT_LANG!) {
  const prompt = `Translate the following text into ${targetLang}:\n\n"${text}"`;
  const resp = await openai.chat.completions.create({
    model: "gpt-4.1-nano",
    messages: [{ role: "system", content: "You are a translation assistant." }, { role: "user", content: prompt }],
    temperature: 0.3
  });
  const content = resp.choices?.[0]?.message?.content;
  return content ? content.trim() : "";
}