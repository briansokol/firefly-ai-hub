import Database from 'better-sqlite3';
import type OpenAI from 'openai';
import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions.js';
import { chatWithHistory } from '../ollama.js';

export interface ConversationMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  tool_calls?: string | null;
  tool_call_id?: string | null;
}

export interface ConversationStore {
  addMessage(convId: string, msg: ConversationMessage): void;
  getHistory(convId: string, limit?: number): ConversationMessage[];
  getMessageCount(convId: string): number;
  clearHistory(convId: string): void;
  summarizeAndTruncate(
    convId: string,
    ollamaClient: OpenAI,
    model: string,
  ): Promise<void>;
  close(): void;
}

const MAX_MESSAGES = 50;
const SUMMARIZE_THRESHOLD = 40;
const TOKEN_ESTIMATE_THRESHOLD = 6000;

function estimateTokens(messages: ConversationMessage[]): number {
  return messages.reduce((sum, m) => sum + Math.ceil(m.content.length / 4), 0);
}

export function createConversationStore(dbPath: string): ConversationStore {
  const db = new Database(dbPath);

  db.exec(`
    CREATE TABLE IF NOT EXISTS conversation_messages (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      conv_id      TEXT NOT NULL,
      role         TEXT NOT NULL,
      content      TEXT NOT NULL,
      tool_calls   TEXT,
      tool_call_id TEXT,
      created_at   TEXT DEFAULT (datetime('now'))
    )
  `);

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_conv_messages
    ON conversation_messages(conv_id, created_at)
  `);

  const insertStmt = db.prepare<[string, string, string, string | null, string | null]>(
    `INSERT INTO conversation_messages (conv_id, role, content, tool_calls, tool_call_id)
     VALUES (?, ?, ?, ?, ?)`,
  );

  const selectStmt = db.prepare<[string, number]>(
    `SELECT role, content, tool_calls, tool_call_id FROM conversation_messages
     WHERE conv_id = ? ORDER BY id DESC LIMIT ?`,
  );

  const countStmt = db.prepare<[string], { cnt: number }>(
    'SELECT COUNT(*) as cnt FROM conversation_messages WHERE conv_id = ?',
  );

  const deleteStmt = db.prepare<[string]>(
    'DELETE FROM conversation_messages WHERE conv_id = ?',
  );

  const deleteOldestStmt = db.prepare<[string, number]>(
    `DELETE FROM conversation_messages WHERE id IN (
       SELECT id FROM conversation_messages WHERE conv_id = ? ORDER BY id ASC LIMIT ?
     )`,
  );

  return {
    addMessage(convId: string, msg: ConversationMessage): void {
      insertStmt.run(
        convId,
        msg.role,
        msg.content,
        msg.tool_calls ?? null,
        msg.tool_call_id ?? null,
      );
    },

    getHistory(convId: string, limit = MAX_MESSAGES): ConversationMessage[] {
      const rows = selectStmt.all(convId, limit) as ConversationMessage[];
      // Rows come in DESC order from query; reverse to chronological
      return rows.reverse();
    },

    getMessageCount(convId: string): number {
      return countStmt.get(convId)?.cnt ?? 0;
    },

    clearHistory(convId: string): void {
      deleteStmt.run(convId);
    },

    async summarizeAndTruncate(
      convId: string,
      ollamaClient: OpenAI,
      model: string,
    ): Promise<void> {
      const allMessages = this.getHistory(convId, MAX_MESSAGES + 20);
      if (
        allMessages.length < SUMMARIZE_THRESHOLD &&
        estimateTokens(allMessages) < TOKEN_ESTIMATE_THRESHOLD
      ) {
        return;
      }

      // Take the oldest messages to summarize
      const toSummarize = allMessages.slice(0, SUMMARIZE_THRESHOLD);
      const formatted = toSummarize
        .filter((m) => m.role === 'user' || m.role === 'assistant')
        .map((m) => `${m.role}: ${m.content}`)
        .join('\n');

      const summaryMessages: ChatCompletionMessageParam[] = [
        {
          role: 'system',
          content:
            'Summarize the key points and context from this conversation in 2-3 paragraphs. ' +
            'Focus on facts, decisions, user preferences, and any ongoing topics. ' +
            'Write in third person (e.g., "The user mentioned...", "They prefer...").',
        },
        { role: 'user', content: formatted },
      ];

      const response = await chatWithHistory(ollamaClient, model, summaryMessages);
      const summary = response.content ?? '(no summary generated)';

      // Delete the old messages and insert the summary
      deleteOldestStmt.run(convId, SUMMARIZE_THRESHOLD);
      insertStmt.run(
        convId,
        'system',
        `[Conversation summary] ${summary}`,
        null,
        null,
      );
    },

    close(): void {
      db.close();
    },
  };
}
