// src/db.ts
import sqlite3 from 'sqlite3';
import { open, Database } from 'sqlite';

let db: Database;

export async function initDB() {
    db = await open({
        filename: './tasks.db',
        driver: sqlite3.Database,
    });

    await db.run(`
        CREATE TABLE IF NOT EXISTS tasks (
            message_id TEXT,
            type TEXT,
            language TEXT,
            status TEXT,
            result TEXT,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (message_id, type, language)
        )
    `
    );
}

export async function getTaskStatus(messageId: string, type: string, language: string) {
    return await db.get<{ status?: string; result?: string }>(
        'SELECT status, result FROM tasks WHERE message_id = ? AND type = ? AND language = ? LIMIT 1',
        messageId, type, language
    );
}

export async function markTaskProcessing(messageId: string, type: string, language: string) {
    await db.run(
        'INSERT OR REPLACE INTO tasks (message_id, type, language, status) VALUES (?, ?, ?, ?)',
        messageId, type, language, 'processing'
    );
}

export async function markTaskDone(messageId: string, type: string, language: string, result: string) {
  await db.run(
    'UPDATE tasks SET status = ?, result = ? WHERE message_id = ? AND type = ? AND language = ?',
    'done', result, messageId, type, language
  );
}

export async function markTaskFailed(messageId: string) {
    await db.run('UPDATE tasks SET status = ? WHERE message_id = ?', 'failed', messageId);
}