import { dayKey, formatDay, toMarkdown } from './note-utils.js';
import { getNote, getAllNotes, findNotes, saveNote, deleteNote, importNotes } from './storage.js';
import { createBackup, parseBackup, MAX_BACKUP_BYTES } from './backup.js';

const $ = id => document.getElementById(id);
const editor = $('note-body');
let activeDay = dayKey();
let savedNote = null;
let baseBody = '';
let revision = null;
let ready = false;
let busy = false;
let queryVersion = 0;
let loadVersion = 0;
let offset = 0;
let searchTimer;
let storageProblem = false;
let conflicting = false;
let allNotes = [];
const draftKey = day => `hitokoto:draft:${day}`;

async function api(path, options = {}) {
  try {
    const url = new URL(path, location.origin);
    if (path === '/export') return toMarkdown(await getAllNotes());
    if (url.pathname === '/notes') return await findNotes(url.searchParams.get('q') ?? '', Number(url.searchParams.get('offset') ?? 0));
    const day = url.pathname.split('/').at(-1);
    if (options.method === 'PUT') { const data = JSON.parse(options.body); return await saveNote(day, data.body, data.revision); }
    if (options.method === 'DELETE') return await deleteNote(day, url.searchParams.get('revision'));
    const note = await getNote(day);
    if (!note) throw Object.assign(new Error('この日のメモはありません。'), { status: 404 });
    return note;
  } catch (error) {
    if (error.status) throw error;
    const message = error.name === 'QuotaExceededError' ? '保存容量が足りません。JSONを書き出してから、不要なメモを削除してください。' : '端末の保存先を開けませんでした。ブラウザの設定を確認して再試行してください。';
    throw new Error(message);
  }
}
function readDraft(day) {
  try {
    const value = JSON.parse(localStorage.getItem(draftKey(day)) || 'null');
    return value && typeof value.body === 'string' && typeof value.baseBody === 'string' && (value.revision === null || typeof value.revision === 'string') ? value : null;
  } catch { return null; }
}
function removeDraft(day) {
  try { localStorage.removeItem(draftKey(day)); } catch { storageProblem = true; }
}
function preserveDraft() {
  if (!ready) return;
  try {
    if (editor.value === baseBody) localStorage.removeItem(draftKey(activeDay));
    else localStorage.setItem(draftKey(activeDay), JSON.stringify({ body: editor.value, baseBody, revision }));
    storageProblem = false;
  } catch { storageProblem = true; }
}
function controls() {
  $('save-button').disabled = !ready || busy || !editor.value.trim() || editor.value === baseBody;
  $('save-button').textContent = busy ? '保存中…' : '保存する';
  $('count').textContent = `${editor.value.length.toLocaleString('ja-JP')}文字`;
  $('delete-button').hidden = !savedNote;
  $('delete-button').disabled = busy || !ready;
  $('export-note').disabled = !editor.value.trim();
  $('today-button').hidden = activeDay === dayKey();
  $('write-tab').disabled = busy;
  $('history-tab').disabled = busy;
  $('today-button').disabled = busy;
  if (storageProblem) $('save-status').textContent = '下書きを端末に残せません。保存または書き出しをしてください。';
}
function setError(message = '', conflict = false) {
  $('editor-error').textContent = message;
  $('editor-error').hidden = !message;
  $('recovery-actions').hidden = !message;
  $('retry-button').hidden = conflict;
  $('latest-button').hidden = !conflict;
  conflicting = conflict;
}
function showView(view) {
  $('editor-view').hidden = view !== 'write';
  $('history-view').hidden = view !== 'history';
  for (const [name, id] of [['write', 'write-tab'], ['history', 'history-tab']]) {
    $(id).classList.toggle('active', view === name);
    if (view === name) $(id).setAttribute('aria-current', 'page');
    else $(id).removeAttribute('aria-current');
  }
}
async function loadDay(day) {
  preserveDraft();
  const version = ++loadVersion;
  activeDay = day;
  ready = false;
  savedNote = null;
  baseBody = '';
  revision = null;
  editor.disabled = true;
  editor.value = '';
  showView('write');
  $('editor-date').textContent = formatDay(day);
  $('editor-heading').textContent = day === dayKey() ? '今日のメモ' : 'この日のメモ';
  $('save-status').textContent = 'メモを読み込んでいます…';
  setError(); controls();
  let draft = readDraft(day);
  try {
    let note = null;
    try { note = await api(`/notes/${day}`); } catch (error) { if (error.status !== 404) throw error; }
    if (version !== loadVersion) return;
    savedNote = note;
    baseBody = note?.body ?? '';
    revision = note?.revision ?? null;
    if (draft?.body === baseBody) { removeDraft(day); draft = null; }
    if (draft) {
      editor.value = draft.body;
      baseBody = draft.baseBody;
      revision = draft.revision;
      $('save-status').textContent = 'この端末の書きかけを復元しました';
      if (revision !== (note?.revision ?? null)) setError('別のタブで更新されています。書きかけを残しています。最新のメモを確認してください。', true);
    } else {
      editor.value = baseBody;
      $('save-status').textContent = note ? '保存済み' : '書きかけはこの端末に残ります';
    }
    ready = true; editor.disabled = false;
  } catch (error) {
    if (version !== loadVersion) return;
    if (draft) {
      editor.value = draft.body; baseBody = draft.baseBody; revision = draft.revision;
    }
    // Keep drafting available if the browser blocks IndexedDB.
    ready = true; editor.disabled = false;
    setError(error.message);
    $('save-status').textContent = '保存先を確認できません。書きかけを入力できます';
  }
  controls();
  if (!$('editor-view').hidden) editor.focus({ preventScroll: true });
}
editor.addEventListener('input', () => {
  preserveDraft();
  $('save-status').textContent = editor.value === baseBody ? (savedNote ? '保存済み' : '書きかけはこの端末に残ります') : '未保存 · 書きかけはこの端末に残ります';
  controls();
});
async function save() {
  if ($('save-button').disabled) return;
  const body = editor.value;
  busy = true; controls();
  try {
    const note = await api(`/notes/${activeDay}`, { method: 'PUT', body: JSON.stringify({ body, revision }) });
    savedNote = note; baseBody = note.body; revision = note.revision;
    preserveDraft();
    setError();
    $('save-status').textContent = editor.value === body ? '保存しました' : '保存済み · その後の入力は未保存です';
  } catch (error) {
    preserveDraft(); setError(error.message, error.status === 409);
    $('save-status').textContent = '未保存 · 入力を残しています';
  } finally { busy = false; controls(); }
}
$('save-button').addEventListener('click', save);
editor.addEventListener('keydown', event => {
  if ((event.metaKey || event.ctrlKey) && event.key === 's') { event.preventDefault(); if (!event.isComposing) save(); }
});
$('write-tab').addEventListener('click', () => {
  if (activeDay !== dayKey()) loadDay(dayKey());
  else { showView('write'); editor.focus({ preventScroll: true }); }
});
$('today-button').addEventListener('click', () => loadDay(dayKey()));
$('retry-button').addEventListener('click', () => loadDay(activeDay));
$('history-tab').addEventListener('click', () => { preserveDraft(); showView('history'); loadHistory(); });

function renderList() {
  const list = $('notes-list'); list.replaceChildren();
  if (!allNotes.length) {
    const empty = document.createElement('li'); empty.className = 'empty';
    const h = document.createElement('h2');
    h.textContent = $('search').value ? 'メモが見つかりませんでした' : 'まだメモがありません';
    const p = document.createElement('p'); p.textContent = $('search').value ? '別の言葉や日付で検索してみてください。' : '思いついたことを、ひとことから。';
    empty.append(h, p);
    if (!$('search').value) {
      const button = document.createElement('button'); button.className = 'primary'; button.textContent = 'メモを書く';
      button.addEventListener('click', () => loadDay(dayKey())); empty.append(button);
    }
    list.append(empty); return;
  }
  for (const note of allNotes) {
    const li = document.createElement('li');
    const button = document.createElement('button'); button.className = 'note-row';
    button.setAttribute('aria-label', `${formatDay(note.day)}のメモを開く`);
    const meta = document.createElement('div'); meta.className = 'note-row-meta';
    const date = document.createElement('p'); date.className = 'note-row-date'; date.textContent = formatDay(note.day);
    const time = document.createElement('span'); time.className = 'note-row-time'; time.textContent = new Intl.DateTimeFormat('ja-JP', { hour: '2-digit', minute: '2-digit' }).format(new Date(note.updated_at));
    const preview = document.createElement('p'); preview.className = 'note-row-preview'; preview.textContent = note.body;
    meta.append(date, time); button.append(meta, preview); li.append(button); list.append(li);
    button.addEventListener('click', () => loadDay(note.day));
  }
}
async function loadHistory(more = false) {
  const version = ++queryVersion;
  if (!more) { offset = 0; allNotes = []; $('notes-list').replaceChildren(); }
  $('load-more').hidden = true;
  $('history-error').hidden = true; $('list-retry').hidden = true;
  $('list-status').textContent = '読み込んでいます…';
  try {
    const result = await api(`/notes?q=${encodeURIComponent($('search').value)}&offset=${offset}`);
    if (version !== queryVersion) return;
    allNotes = more ? [...allNotes, ...result.notes] : result.notes;
    offset = allNotes.length;
    renderList();
    $('list-status').textContent = allNotes.length ? `${allNotes.length}日分のメモ${result.hasMore ? 'を表示' : ''}` : '';
    $('load-more').hidden = !result.hasMore;
  } catch (error) {
    if (version !== queryVersion) return;
    $('list-status').textContent = '';
    $('history-error').textContent = error.message; $('history-error').hidden = false;
    $('list-retry').hidden = false;
  }
}
$('search').addEventListener('input', () => {
  // Invalidate older requests immediately, before starting the debounce.
  ++queryVersion; clearTimeout(searchTimer); searchTimer = setTimeout(() => loadHistory(), 220);
});
$('search-form').addEventListener('submit', event => { event.preventDefault(); clearTimeout(searchTimer); loadHistory(); });
$('list-retry').addEventListener('click', () => loadHistory());
$('load-more').addEventListener('click', () => loadHistory(true));

function download(content, filename, type = 'text/markdown;charset=utf-8') {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const link = document.createElement('a'); link.href = url; link.download = filename;
  document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 30000);
}
function exportCurrent() { download(toMarkdown([{ day: activeDay, body: editor.value }]), `${activeDay}.md`); }
$('export-note').addEventListener('click', exportCurrent);
$('copy-button').addEventListener('click', exportCurrent);
$('export-all').addEventListener('click', async () => {
  const button = $('export-all'); button.disabled = true;
  try { download(await api('/export'), 'hitokoto-notes.md'); }
  catch (error) { $('history-error').textContent = error.message; $('history-error').hidden = false; }
  finally { button.disabled = false; }
});

$('delete-button').addEventListener('click', () => {
  $('delete-date').textContent = formatDay(activeDay);
  $('confirm-delete').disabled = false; $('confirm-delete').textContent = '削除する';
  $('delete-dialog').showModal(); $('cancel-delete').focus();
});
$('cancel-delete').addEventListener('click', () => $('delete-dialog').close());
$('confirm-delete').addEventListener('click', async () => {
  const button = $('confirm-delete'); button.disabled = true; button.textContent = '削除中…';
  busy = true; controls();
  try {
    await api(`/notes/${activeDay}?revision=${savedNote.revision}`, { method: 'DELETE' });
    removeDraft(activeDay); editor.value = ''; baseBody = ''; revision = null; savedNote = null;
    setError(); $('save-status').textContent = '削除しました';
    $('delete-dialog').close();
    showView('history'); await loadHistory();
  } catch (error) {
    $('delete-dialog').close(); setError(error.message, error.status === 409);
  } finally { busy = false; button.disabled = false; controls(); }
});

$('latest-button').addEventListener('click', async () => {
  const button = $('latest-button'); button.disabled = true;
  try {
    let latest = null;
    try { latest = await api(`/notes/${activeDay}`); } catch (error) { if (error.status !== 404) throw error; }
    const dialog = document.createElement('dialog');
    const heading = document.createElement('h2'); heading.textContent = latest ? '別のタブの最新メモ' : '別のタブで削除されています';
    const content = document.createElement('textarea'); content.readOnly = true; content.value = latest?.body ?? ''; content.setAttribute('aria-label', '最新のメモ本文'); content.style.height = '220px';
    const caption = document.createElement('p'); caption.className = 'dialog-caption'; caption.textContent = latest ? '最新の本文に書きかけを追加してから、内容を整理して保存できます。' : '書きかけを使って、この日のメモを作り直せます。';
    const actions = document.createElement('div'); actions.className = 'dialog-actions';
    const cancel = document.createElement('button'); cancel.className = 'secondary'; cancel.textContent = '戻る';
    const merge = document.createElement('button'); merge.className = 'primary'; merge.textContent = latest ? '書きかけを追加' : '書きかけを使う';
    cancel.addEventListener('click', () => dialog.close());
    merge.addEventListener('click', () => {
      editor.value = latest ? `${latest.body}\n\n${editor.value}` : editor.value;
      savedNote = latest; baseBody = latest?.body ?? ''; revision = latest?.revision ?? null;
      preserveDraft(); setError(); controls();
      $('save-status').textContent = '未保存 · 内容を確認して保存してください';
      dialog.close(); editor.focus({ preventScroll: true });
    });
    actions.append(cancel, merge); dialog.append(heading, content, caption, actions); document.body.append(dialog);
    dialog.addEventListener('close', () => dialog.remove(), { once: true }); dialog.showModal(); cancel.focus();
  } catch (error) { setError(error.message, conflicting); }
  finally { button.disabled = false; }
});

window.addEventListener('pagehide', preserveDraft);
document.addEventListener('visibilitychange', () => { if (document.hidden) preserveDraft(); });
window.addEventListener('beforeunload', event => {
  preserveDraft();
  if (storageProblem && editor.value !== baseBody) { event.preventDefault(); event.returnValue = ''; }
});
window.addEventListener('storage', event => {
  if (event.key === draftKey(activeDay) && ready && event.newValue && readDraft(activeDay)?.body !== editor.value) {
    // Avoid silently overwriting a draft typed in another browser tab.
    setError('別のタブにも書きかけがあります。必要な本文を書き出してから保存してください。');
  }
});
setInterval(() => {
  if (activeDay !== dayKey() && ready && !busy && editor.value === '' && baseBody === '' && !$('editor-view').hidden) loadDay(dayKey());
}, 60000);
loadDay(activeDay);

async function exportJson(button) {
  button.disabled = true;
  try {
    download(createBackup(await getAllNotes()), `hitokoto-${dayKey()}.json`, 'application/json;charset=utf-8');
    if (!$('history-view').hidden) $('list-status').textContent = '保存済みメモをJSONに書き出しました';
    else $('save-status').textContent = editor.value === baseBody ? 'JSONを書き出しました' : '保存済みメモをJSONに書き出しました · 書きかけは未保存です';
  } catch (error) {
    if ($('history-view').hidden) setError('JSONを書き出せませんでした。もう一度お試しください。');
    else { $('history-error').textContent = 'JSONを書き出せませんでした。もう一度お試しください。'; $('history-error').hidden = false; }
  } finally { button.disabled = false; }
}
for (const id of ['export-json', 'export-json-editor']) $(id).addEventListener('click', () => exportJson($(id)));
$('import-json').addEventListener('click', () => $('import-file').click());
let pendingImport = null;
$('import-file').addEventListener('change', async () => {
  const file = $('import-file').files[0]; $('import-file').value = '';
  if (!file) return;
  try {
    if (file.size > MAX_BACKUP_BYTES) throw new Error('JSONファイルは20MB以内で読み込んでください。');
    const notes = parseBackup(await file.text());
    if (!notes.length) throw new Error('このファイルにはメモがありません。');
    const existing = new Set((await getAllNotes()).map(note => note.day));
    const duplicates = notes.filter(note => existing.has(note.day)).length;
    pendingImport = notes;
    $('import-summary').textContent = `${notes.length}日分のメモがあります。新規 ${notes.length - duplicates}日分、同じ日付 ${duplicates}日分。`;
    $('overwrite').checked = false;
    $('import-policy').textContent = '同じ日付のメモは、この端末の本文を残します。';
    $('overwrite-option').hidden = !duplicates;
    $('import-dialog-error').hidden = true;
    $('confirm-import').disabled = false; $('confirm-import').textContent = '読み込む';
    $('import-dialog').showModal(); $('cancel-import').focus();
  } catch (error) { $('history-error').textContent = error.message; $('history-error').hidden = false; }
});
$('cancel-import').addEventListener('click', () => $('import-dialog').close());
$('overwrite').addEventListener('change', () => {
  $('import-policy').textContent = $('overwrite').checked ? '同じ日付の本文を置き換えます。必要な場合は先にJSONを書き出してください。' : '同じ日付のメモは、この端末の本文を残します。';
});
$('import-dialog').addEventListener('close', () => { pendingImport = null; });
$('confirm-import').addEventListener('click', async () => {
  if (!pendingImport) return;
  const button = $('confirm-import'); button.disabled = true; button.textContent = '読み込み中…';
  $('cancel-import').disabled = true;
  try {
    const result = await importNotes(pendingImport, $('overwrite').checked);
    $('import-dialog').close(); await loadHistory();
    $('list-status').textContent = `読み込みました · 追加 ${result.added}日、置換 ${result.replaced}日、既存を維持 ${result.skipped}日`;
    // Refresh current note next time it is opened, while preserving its draft.
    ready = false;
    await loadDay(activeDay); showView('history');
  } catch (error) {
    $('import-dialog-error').textContent = '読み込みを保存できませんでした。元のメモは変更していません。保存容量やブラウザの設定を確認してください。';
    $('import-dialog-error').hidden = false;
  } finally { button.disabled = false; button.textContent = '読み込む'; $('cancel-import').disabled = false; }
});
if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
