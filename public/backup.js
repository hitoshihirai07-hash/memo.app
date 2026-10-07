import { validDay, normalizeTags } from './note-utils.js';
export const MAX_BACKUP_BYTES = 20 * 1024 * 1024;
export function parseBackup(text) {
  if (typeof text !== 'string' || new TextEncoder().encode(text).length > MAX_BACKUP_BYTES) throw new Error('JSONファイルは20MB以内で読み込んでください。');
  let data;
  try { data = JSON.parse(text.replace(/^\uFEFF/, '')); } catch { throw new Error('JSONの形式が正しくありません。'); }
  if (!data || data.app !== 'hitokoto' || ![1, 2].includes(data.version) || !Array.isArray(data.notes)) throw new Error('ひとことから書き出したJSONファイルを選んでください。');
  if (data.notes.length > 10000) throw new Error('1万件以内で読み込んでください。');
  const seen = new Set();
  const notes = data.notes.map((note, index) => {
    if (!note || typeof note.day !== 'string' || !validDay(note.day) || typeof note.body !== 'string' || !note.body.trim() || note.body.length > 100000 || typeof note.updated_at !== 'string' || !/^\d{4}-\d\d-\d\dT/.test(note.updated_at) || !Number.isFinite(Date.parse(note.updated_at))) throw new Error(`${index + 1}件目のメモの日付・本文・更新日時を確認してください。`);
    const id = data.version === 1 ? `legacy:${note.day}` : note.id;
    if (typeof id !== 'string' || !/^[a-zA-Z0-9:_-]{1,100}$/.test(id)) throw new Error(`${index + 1}件目のノートIDを確認してください。`);
    if (seen.has(id)) throw new Error('同じノートがファイル内で重複しています。');
    seen.add(id);
    const created = data.version === 1 ? note.updated_at : note.created_at;
    if (typeof created !== 'string' || !/^\d{4}-\d\d-\d\dT/.test(created) || !Number.isFinite(Date.parse(created))) throw new Error(`${index + 1}件目の作成日時を確認してください。`);
    return { id, day: note.day, body: note.body, tags: data.version === 1 ? [] : normalizeTags(note.tags), created_at: new Date(created).toISOString(), updated_at: new Date(note.updated_at).toISOString() };
  });
  const catalog = data.version === 1 ? [] : (data.tags ?? []);
  if (!Array.isArray(catalog) || catalog.length > 10000) throw new Error('登録済みタグの形式を確認してください。');
  const tags = [...new Set([...catalog.flatMap(tag => normalizeTags([tag])), ...notes.flatMap(note => note.tags)])];
  return { notes, tags };
}
export function createBackup(notes, tags = []) {
  return JSON.stringify({ app: 'hitokoto', version: 2, exportedAt: new Date().toISOString(), tags: [...new Set([...tags, ...notes.flatMap(note => note.tags ?? [])])], notes: [...notes].sort((a, b) => b.day.localeCompare(a.day) || (b.created_at ?? '').localeCompare(a.created_at ?? '')).map(({ id, day, body, tags = [], created_at, updated_at }) => ({ id: id ?? `legacy:${day}`, day, body, tags, created_at: created_at ?? updated_at, updated_at })) }, null, 2);
}
