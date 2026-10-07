import { validDay, normalizeTags } from './note-utils.js';
let database;
export function openStore() {
  if (!database) database = new Promise((resolve, reject) => {
    const request = indexedDB.open('hitokoto-notes', 2);
    request.onupgradeneeded = () => {
      const db = request.result;
      const entries = db.createObjectStore('entries', { keyPath: 'id' });
      db.createObjectStore('tags', { keyPath: 'name' });
      if (db.objectStoreNames.contains('notes')) {
        const old = request.transaction.objectStore('notes').getAll();
        old.onsuccess = () => {
          for (const note of old.result) entries.put({ ...note, id: `legacy:${note.day}`, created_at: note.updated_at, tags: [] });
        };
      }
    };
    request.onsuccess = () => {
      request.result.onversionchange = () => { request.result.close(); database = null; };
      resolve(request.result);
    };
    request.onerror = () => { database = null; reject(request.error); };
    request.onblocked = () => { database = null; reject(new Error('他のタブを閉じてから、開き直してください。')); };
  });
  return database;
}
async function transaction(mode, operation) {
  const db = await openStore();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(mode === 'readwrite' ? ['entries', 'tags'] : ['entries'], mode);
    let result, failure;
    tx.oncomplete = () => resolve(result);
    tx.onabort = () => reject(failure || tx.error || new Error('保存が中断されました。'));
    tx.onerror = () => {};
    const setResult = value => { result = value; };
    const fail = error => { failure = error; tx.abort(); };
    try { operation(tx.objectStore('entries'), setResult, fail, mode === 'readwrite' ? tx.objectStore('tags') : null); } catch (error) { fail(error); }
  });
}
function conflict() { return Object.assign(new Error('別のタブで更新されています。書きかけを残しています。最新のメモを確認してください。'), { status: 409 }); }
export function getNote(id) {
  return transaction('readonly', (store, done) => { const request = store.get(id); request.onsuccess = () => done(request.result ?? null); });
}
export function getAllNotes() {
  return transaction('readonly', (store, done) => { const request = store.getAll(); request.onsuccess = () => done(request.result.sort((a, b) => b.day.localeCompare(a.day) || b.created_at.localeCompare(a.created_at) || a.id.localeCompare(b.id))); });
}
export async function findNotes(q = '', offset = 0) {
  const needle = q.toLocaleLowerCase('ja-JP');
  const notes = (await getAllNotes()).filter(note => note.body.toLocaleLowerCase('ja-JP').includes(needle) || note.day.includes(needle) || note.tags.some(tag => tag.toLocaleLowerCase('ja-JP').includes(needle)));
  return { notes: notes.slice(offset, offset + 30), hasMore: notes.length > offset + 30 };
}
export function saveNote(input, revision) {
  if (!input.id || !validDay(input.day) || typeof input.body !== 'string' || !input.body.trim() || input.body.length > 100000) throw new Error('本文を入力してください（10万文字以内）。');
  const tags = normalizeTags(input.tags);
  return transaction('readwrite', (store, done, fail, catalog) => {
    const read = store.get(input.id);
    read.onsuccess = () => {
      if ((read.result?.revision ?? null) !== revision) return fail(conflict());
      const now = new Date().toISOString();
      const note = { id: input.id, day: read.result?.day ?? input.day, body: input.body, tags, created_at: read.result?.created_at ?? now, revision: crypto.randomUUID(), updated_at: now };
      for (const name of tags) catalog.put({ name });
      store.put(note); done(note);
    };
  });
}
export function deleteNote(id, revision) {
  return transaction('readwrite', (store, done, fail) => {
    const read = store.get(id);
    read.onsuccess = () => {
      if (!read.result || read.result.revision !== revision) return fail(conflict());
      store.delete(id); done(null);
    };
  });
}
export function importNotes(notes, overwrite = false, tags = []) {
  return transaction('readwrite', (store, done, fail, catalog) => {
    const counts = { added: 0, replaced: 0, skipped: 0 };
    done(counts);
    for (const name of tags) catalog.put({ name });
    for (const note of notes) {
      for (const name of note.tags) catalog.put({ name });
      const read = store.get(note.id);
      read.onsuccess = () => {
        if (read.result && !overwrite) { counts.skipped++; return; }
        if (read.result) counts.replaced++; else counts.added++;
        store.put({ ...note, revision: crypto.randomUUID() });
      };
    }
  });
}
export async function getAllTags() {
  const db = await openStore();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('tags', 'readonly');
    const read = tx.objectStore('tags').getAll();
    tx.oncomplete = () => resolve(read.result.map(tag => tag.name).sort((a, b) => a.localeCompare(b, 'ja')));
    tx.onabort = () => reject(tx.error);
  });
}
export async function rememberTag(tag) {
  const [name] = normalizeTags([tag]);
  await transaction('readwrite', (store, done, fail, catalog) => catalog.put({ name }));
  return name;
}
