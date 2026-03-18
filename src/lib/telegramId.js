/**
 * Shared Telegram user-ID resolution and caching.
 */

import fs from "node:fs";
import { TELEGRAM_CHAT_ID_FILE } from "./config.js";

/**
 * Synchronously read cached Telegram numeric user ID from disk.
 * @returns {string} numeric ID or ""
 */
export function readCachedTelegramId() {
  try {
    const id = fs.readFileSync(TELEGRAM_CHAT_ID_FILE, "utf8").trim();
    return /^\d+$/.test(id) ? id : "";
  } catch {
    return "";
  }
}

/**
 * Synchronously write a numeric Telegram user ID to the cache file.
 * @param {string} id
 */
export function writeCachedTelegramId(id) {
  if (!id || !/^\d+$/.test(String(id))) return;
  fs.writeFileSync(TELEGRAM_CHAT_ID_FILE, String(id), "utf8");
}

/**
 * Resolve a Telegram @username to a numeric user ID via Bot API getUpdates.
 * If the username is already numeric, returns it directly.
 * On success, also writes the ID to the cache file.
 * @param {string} botToken
 * @param {string} username - may include leading @
 * @returns {Promise<string>} numeric ID or ""
 */
export async function resolveTelegramUserId(botToken, username) {
  if (!botToken || !username) return "";

  const clean = username.replace(/^@/, "").trim();
  if (!clean) return "";

  // Already numeric — use directly
  if (/^\d+$/.test(clean)) {
    writeCachedTelegramId(clean);
    return clean;
  }

  try {
    const res = await fetch(
      `https://api.telegram.org/bot${botToken}/getUpdates?limit=100`
    );
    const data = await res.json();
    if (!data.ok || !Array.isArray(data.result)) return "";

    const lc = clean.toLowerCase();
    for (const update of data.result) {
      const chat = update.message?.chat || update.my_chat_member?.chat;
      const from = update.message?.from || update.my_chat_member?.from;
      if (chat?.username?.toLowerCase() === lc) {
        const id = String(chat.id);
        writeCachedTelegramId(id);
        console.log(`[telegram] Async resolved @${clean} → ${id}`);
        return id;
      }
      if (from?.username?.toLowerCase() === lc) {
        const id = String(chat?.id || from?.id);
        writeCachedTelegramId(id);
        console.log(`[telegram] Async resolved @${clean} → ${id}`);
        return id;
      }
    }
  } catch (err) {
    console.warn(`[telegram] resolveTelegramUserId error: ${err.message}`);
  }
  return "";
}
