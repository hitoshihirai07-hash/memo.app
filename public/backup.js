import { validDay } from './note-utils.js';
export const MAX_BACKUP_BYTES = 20 * 1024 * 1024;
export function parseBackup(text) {
  if (typeof text !== 'string' || new TextEncoder().encode(text).length > MAX_BACKUP_BYTES) throw new Error('JSONファイルは20MB以内で読み込んでください。');
  let data;
  try { data = JSON.parse(text.replace(/^\uFEFF/, '')); } catch { throw new Error('JSONの形式が正しくありません。'); }
  if (!data || data.app !== 'hitokoto' || data.version !== 1 || !Array.isArray(data.notes)) throw new Error('ひとことから書き出したJSONファイルを選んでください。');
  if (data.notes.length > 10000) throw new Error('1万日分以内で読み込んでください。');
  const seen = new Set();
  return data.notes.map((note, index) => {
    if (!note || typeof note.day !== 'string' || !validDay(note.day) || typeof note.body !== 'string' || !note.body.trim() || note.body.length > 100000 || typeof note.updated_at !== 'string' || !/^\d{4}-\d\d-\d\dT/.test(note.updated_at) || !Number.isFinite(Date.parse(note.updated_at))) throw new Error(`${index + 1}件目のメモの日付・本文・更新日時を確認してください。`);
    if (seen.has(note.day)) throw new Error(`${note.day}のメモがファイル内で重複しています。`);
    seen.add(note.day);
    return { day: note.day, body: note.body, updated_at: new Date(note.updated_at).toISOString() };
  });
}
export function createBackup(notes) {
  return JSON.stringify({ app: 'hitokoto', version: 1, exportedAt: new Date().toISOString(), notes: [...notes].sort((a, b) => b.day.localeCompare(a.day)).map(({ day, body, updated_at }) => ({ day, body, updated_at })) }, null, 2);
}
