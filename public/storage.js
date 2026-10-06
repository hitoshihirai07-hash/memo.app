import { validDay } from './note-utils.js';
let database;
export function openStore() {
  if (!database) database = new Promise((resolve, reject) => {
    const request = indexedDB.open('hitokoto-notes', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('notes', { keyPath: 'day' });
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
    const tx = db.transaction('notes', mode);
    let result, failure;
    tx.oncomplete = () => resolve(result);
    tx.onabort = () => reject(failure || tx.error || new Error('保存が中断されました。'));
    tx.onerror = () => {};
    const setResult = value => { result = value; };
    const fail = error => { failure = error; tx.abort(); };
    try { operation(tx.objectStore('notes'), setResult, fail); } catch (error) { fail(error); }
  });
}
function conflict() { return Object.assign(new Error('別のタブで更新されています。書きかけを残しています。最新のメモを確認してください。'), { status: 409 }); }
export function getNote(day) {
  return transaction('readonly', (store, done) => { const request = store.get(day); request.onsuccess = () => done(request.result ?? null); });
}
export function getAllNotes() {
  return transaction('readonly', (store, done) => { const request = store.getAll(); request.onsuccess = () => done(request.result.sort((a, b) => b.day.localeCompare(a.day))); });
}
export async function findNotes(q = '', offset = 0) {
  const needle = q.toLocaleLowerCase('ja-JP');
  const notes = (await getAllNotes()).filter(note => note.body.toLocaleLowerCase('ja-JP').includes(needle) || note.day.includes(needle));
  return { notes: notes.slice(offset, offset + 30), hasMore: notes.length > offset + 30 };
}
export function saveNote(day, body, revision) {
  if (!validDay(day) || typeof body !== 'string' || !body.trim() || body.length > 100000) throw new Error('本文を入力してください（10万文字以内）。');
  return transaction('readwrite', (store, done, fail) => {
    const read = store.get(day);
    read.onsuccess = () => {
      if ((read.result?.revision ?? null) !== revision) return fail(conflict());
      const note = { day, body, revision: crypto.randomUUID(), updated_at: new Date().toISOString() };
      store.put(note); done(note);
    };
  });
}
export function deleteNote(day, revision) {
  return transaction('readwrite', (store, done, fail) => {
    const read = store.get(day);
    read.onsuccess = () => {
      if (!read.result || read.result.revision !== revision) return fail(conflict());
      store.delete(day); done(null);
    };
  });
}
export function importNotes(notes, overwrite = false) {
  return transaction('readwrite', (store, done) => {
    const counts = { added: 0, replaced: 0, skipped: 0 };
    done(counts);
    for (const note of notes) {
      const read = store.get(note.day);
      read.onsuccess = () => {
        if (read.result && !overwrite) { counts.skipped++; return; }
        if (read.result) counts.replaced++; else counts.added++;
        store.put({ ...note, revision: crypto.randomUUID() });
      };
    }
  });
}
