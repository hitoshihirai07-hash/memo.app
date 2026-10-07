import { dayKey, formatDay, formatTime, toMarkdown, normalizeTags, validDay } from './note-utils.js';
import { getNote, getAllNotes, saveNote, deleteNote, importNotes, getAllTags, rememberTag } from './storage.js';
import { createBackup, parseBackup, MAX_BACKUP_BYTES } from './backup.js';

const $ = id => document.getElementById(id);
const editor = $('note-body');
const PREFIX = 'hitokoto:draft:v2:';
const ACTIVE = 'hitokoto:active-entry';
let activeId, activeDay, createdAt, savedNote = null, revision = null;
let selectedTags = [], baseTags = [], baseBody = '', catalog = [];
let ready = false, busy = false, storageProblem = false, conflicting = false;
let loadVersion = 0, queryVersion = 0, shown = 30, historyNotes = [], searchTimer;
let pendingImport = null;
const sameTags = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const dirty = () => editor.value !== baseBody || !sameTags(selectedTags, baseTags);

function message(error) {
  if (error.status === 409) return error.message;
  if (error.name === 'QuotaExceededError') return '保存容量が足りません。JSONを書き出してから、不要なメモを削除してください。';
  return error.message || '端末の保存先を開けませんでした。もう一度お試しください。';
}
function readDraft(id) {
  try {
    const value = JSON.parse(localStorage.getItem(PREFIX + id) || 'null');
    if (!value || !validDay(value.day) || typeof value.body !== 'string' || typeof value.baseBody !== 'string' || !(value.revision === null || typeof value.revision === 'string')) return null;
    return { ...value, id, tags: normalizeTags(value.tags ?? []), baseTags: normalizeTags(value.baseTags ?? []) };
  } catch { return null; }
}
function allDrafts() {
  const drafts = [];
  try {
    for (const key of Object.keys(localStorage)) {
      if (key.startsWith(PREFIX)) { const draft = readDraft(key.slice(PREFIX.length)); if (draft && (draft.body.trim() || draft.tags.length)) drafts.push(draft); }
    }
  } catch { storageProblem = true; }
  return drafts;
}
function migrateDrafts() {
  try {
    for (const key of Object.keys(localStorage)) {
      if (!/^hitokoto:draft:\d{4}-\d{2}-\d{2}$/.test(key)) continue;
      let old;
      try { old = JSON.parse(localStorage.getItem(key)); } catch { continue; }
      if (!old || typeof old.body !== 'string' || typeof old.baseBody !== 'string') continue;
      const day = key.slice(-10), id = `legacy:${day}`;
      if (!localStorage.getItem(PREFIX + id)) localStorage.setItem(PREFIX + id, JSON.stringify({ ...old, day, tags: [], baseTags: [], created_at: `${day}T12:00:00.000Z`, updated_at: new Date().toISOString() }));
      localStorage.removeItem(key);
    }
  } catch { storageProblem = true; }
}
function removeDraft(id) {
  try { localStorage.removeItem(PREFIX + id); } catch { storageProblem = true; }
}
function preserveDraft() {
  if (!ready || !activeId) return;
  try {
    localStorage.setItem(ACTIVE, activeId);
    if (!dirty()) localStorage.removeItem(PREFIX + activeId);
    else localStorage.setItem(PREFIX + activeId, JSON.stringify({ day: activeDay, body: editor.value, tags: selectedTags, baseBody, baseTags, revision, created_at: createdAt, updated_at: new Date().toISOString() }));
    storageProblem = false;
  } catch { storageProblem = true; }
}
function setError(text = '', conflict = false) {
  $('editor-error').textContent = text; $('editor-error').hidden = !text;
  $('recovery-actions').hidden = !text;
  $('retry-button').hidden = conflict; $('latest-button').hidden = !conflict;
  conflicting = conflict;
}
function controls() {
  $('save-button').disabled = !ready || busy || !editor.value.trim() || !dirty();
  $('save-button').textContent = busy ? '保存中…' : '保存する';
  $('count').textContent = `${editor.value.length.toLocaleString('ja-JP')}文字`;
  $('delete-button').hidden = !savedNote && !editor.value.trim();
  $('delete-button').disabled = !ready || busy;
  $('export-note').disabled = !editor.value.trim();
  for (const id of ['new-button', 'write-tab', 'history-tab', 'add-tag', 'tag-input']) $(id).disabled = !ready || busy;
  document.querySelectorAll('.tag-chip').forEach(button => { button.disabled = busy; });
  if (storageProblem) $('save-status').textContent = '書きかけを端末に残せません。保存または書き出しをしてください。';
}
function changed() {
  preserveDraft();
  $('save-status').textContent = dirty() ? '未保存 · 書きかけはこの端末に残ります' : savedNote ? '保存済み' : '書きかけはこの端末に残ります';
  controls();
}
function showView(view) {
  $('editor-view').hidden = view !== 'write'; $('history-view').hidden = view !== 'history';
  for (const [name, id] of [['write', 'write-tab'], ['history', 'history-tab']]) {
    $(id).classList.toggle('active', name === view);
    if (name === view) $(id).setAttribute('aria-current', 'page'); else $(id).removeAttribute('aria-current');
  }
}
function updateHeading() {
  $('editor-heading').textContent = savedNote ? 'メモを編集' : '新しいメモ';
  $('editor-date').textContent = formatDay(activeDay) + (savedNote ? ` ${formatTime(savedNote.created_at)}` : '');
}
function renderTags() {
  const selected = $('selected-tags'), suggestions = $('tag-suggestions');
  selected.replaceChildren(); suggestions.replaceChildren(); $('tag-options').replaceChildren();
  for (const tag of selectedTags) {
    const button = document.createElement('button'); button.className = 'tag-chip selected'; button.type = 'button';
    button.textContent = `${tag} ×`; button.setAttribute('aria-label', `${tag}を外す`);
    button.addEventListener('click', () => { selectedTags = selectedTags.filter(value => value !== tag); renderTags(); changed(); }); selected.append(button);
  }
  for (const tag of catalog) {
    const option = document.createElement('option'); option.value = tag; $('tag-options').append(option);
    if (selectedTags.includes(tag)) continue;
    const button = document.createElement('button'); button.type = 'button'; button.className = 'tag-chip'; button.textContent = tag;
    button.addEventListener('click', () => addTag(tag)); suggestions.append(button);
  }
  $('tag-library').hidden = !catalog.length;
  controls();
}
async function refreshTags() {
  try { catalog = await getAllTags(); renderTags(); }
  catch (error) { setError(message(error)); }
}
async function addTag(value = $('tag-input').value) {
  if (busy) return;
  try {
    normalizeTags([...selectedTags, value]);
    const id = activeId;
    const tag = normalizeTags([value])[0];
    // Keep the tag available even if this note is never saved.
    await rememberTag(tag);
    if (!catalog.includes(tag)) catalog.push(tag);
    catalog.sort((a, b) => a.localeCompare(b, 'ja'));
    if (id !== activeId) { renderTags(); return; }
    selectedTags = normalizeTags([...selectedTags, tag]);
    $('tag-input').value = ''; $('tag-error').hidden = true;
    renderTags(); changed();
  } catch (error) { $('tag-error').textContent = message(error); $('tag-error').hidden = false; }
}
$('add-tag').addEventListener('click', () => addTag());
$('tag-input').addEventListener('keydown', event => {
  if (event.key === 'Enter' && !event.isComposing) { event.preventDefault(); addTag(); }
});
function newNote() {
  if (busy) return;
  preserveDraft(); ++loadVersion;
  activeId = crypto.randomUUID(); activeDay = dayKey(); createdAt = new Date().toISOString();
  savedNote = null; revision = null; baseBody = ''; baseTags = []; selectedTags = [];
  editor.value = ''; editor.disabled = false; ready = true;
  $('tag-input').value = ''; $('tag-error').hidden = true; $('tag-library').open = false;
  setError(); updateHeading(); showView('write'); renderTags();
  $('save-status').textContent = '書きかけはこの端末に残ります';
  preserveDraft(); controls(); editor.focus({ preventScroll: true }); refreshTags();
}
async function loadEntry(id, show = true) {
  preserveDraft(); const version = ++loadVersion;
  ready = false; activeId = id; editor.disabled = true; controls();
  const draft = readDraft(id);
  try {
    const note = await getNote(id);
    if (version !== loadVersion) return;
    if (!note && !draft) { newNote(); return; }
    savedNote = note; activeDay = note?.day ?? draft.day; createdAt = note?.created_at ?? draft.created_at;
    baseBody = note?.body ?? ''; baseTags = note?.tags ?? []; revision = note?.revision ?? null;
    selectedTags = [...baseTags]; editor.value = baseBody;
    setError();
    if (draft && (draft.body !== baseBody || !sameTags(draft.tags, baseTags))) {
      editor.value = draft.body; selectedTags = [...draft.tags]; baseBody = draft.baseBody; baseTags = [...draft.baseTags]; revision = draft.revision;
      $('save-status').textContent = 'この端末の書きかけを復元しました';
      if (revision !== (note?.revision ?? null)) setError('別のタブやJSON読込で更新されています。書きかけを残しています。最新のメモを確認してください。', true);
    } else { removeDraft(id); $('save-status').textContent = '保存済み'; }
    ready = true; editor.disabled = false;
    updateHeading(); renderTags(); preserveDraft();
    if (show) { showView('write'); editor.focus({ preventScroll: true }); }
    await refreshTags();
  } catch (error) {
    if (version !== loadVersion) return;
    if (draft) {
      activeDay = draft.day; createdAt = draft.created_at; savedNote = null;
      editor.value = draft.body; selectedTags = [...draft.tags]; baseBody = draft.baseBody; baseTags = [...draft.baseTags]; revision = draft.revision;
    } else { activeDay ??= dayKey(); createdAt ??= new Date().toISOString(); }
    ready = true; editor.disabled = false; setError(message(error)); updateHeading(); renderTags();
    if (show) showView('write');
  }
  controls();
}
editor.addEventListener('input', changed);
async function save() {
  if ($('save-button').disabled) return;
  const input = { id: activeId, day: activeDay, body: editor.value, tags: [...selectedTags] };
  busy = true; controls();
  try {
    const note = await saveNote(input, revision);
    savedNote = note; revision = note.revision; baseBody = note.body; baseTags = [...note.tags]; createdAt = note.created_at;
    preserveDraft(); setError(); updateHeading();
    $('save-status').textContent = dirty() ? '保存済み · その後の入力は未保存です' : '保存しました · 新規から次のメモへ';
  } catch (error) { preserveDraft(); setError(message(error), error.status === 409); $('save-status').textContent = '未保存 · 入力を残しています'; }
  finally { busy = false; controls(); }
}
$('save-button').addEventListener('click', save);
editor.addEventListener('keydown', event => { if ((event.ctrlKey || event.metaKey) && event.key === 's') { event.preventDefault(); if (!event.isComposing) save(); } });
$('new-button').addEventListener('click', newNote);
$('write-tab').addEventListener('click', () => { showView('write'); editor.focus({ preventScroll: true }); });
$('retry-button').addEventListener('click', () => loadEntry(activeId));
$('history-tab').addEventListener('click', () => { preserveDraft(); showView('history'); loadHistory(); });

function renderList() {
  const q = $('search').value.toLocaleLowerCase('ja-JP'), tag = $('tag-filter').value;
  const filtered = historyNotes.filter(note => (!tag || note.tags.includes(tag)) && (!q || [note.body, note.day, ...note.tags].some(value => value.toLocaleLowerCase('ja-JP').includes(q))));
  const list = $('notes-list'); list.replaceChildren();
  $('list-status').textContent = filtered.length ? `${filtered.length}件のメモ` : '';
  $('load-more').hidden = filtered.length <= shown;
  if (!filtered.length) {
    const empty = document.createElement('li'); empty.className = 'empty';
    const h = document.createElement('h2'); h.textContent = q || tag ? 'メモが見つかりませんでした' : 'まだメモがありません';
    const p = document.createElement('p'); p.textContent = q || tag ? '別の言葉やタグで探してみてください。' : '思いついたことを、ひとことから。'; empty.append(h, p);
    if (!q && !tag) { const button = document.createElement('button'); button.className = 'primary'; button.textContent = 'メモを書く'; button.addEventListener('click', newNote); empty.append(button); }
    list.append(empty); return;
  }
  for (const note of filtered.slice(0, shown)) {
    const li = document.createElement('li'), button = document.createElement('button'); button.className = 'note-row';
    const meta = document.createElement('div'); meta.className = 'note-row-meta';
    const date = document.createElement('p'); date.className = 'note-row-date'; date.textContent = formatDay(note.day);
    const time = document.createElement('span'); time.className = 'note-row-time'; time.textContent = `${formatTime(note.created_at)}${note.draft ? ' · 書きかけ' : ''}`;
    const preview = document.createElement('p'); preview.className = 'note-row-preview'; preview.textContent = note.body || 'タグのみの書きかけ';
    meta.append(date, time); button.append(meta, preview);
    if (note.tags.length) { const tags = document.createElement('p'); tags.className = 'row-tags'; tags.textContent = note.tags.map(tag => `#${tag}`).join('  '); button.append(tags); }
    li.append(button); list.append(li); button.addEventListener('click', () => loadEntry(note.id));
  }
}
async function loadHistory() {
  const version = ++queryVersion; shown = 30;
  $('list-status').textContent = '読み込んでいます…'; $('history-error').hidden = true; $('list-retry').hidden = true;
  try {
    const [notes, tags] = await Promise.all([getAllNotes(), getAllTags()]);
    if (version !== queryVersion) return;
    const map = new Map(notes.map(note => [note.id, note]));
    for (const draft of allDrafts()) map.set(draft.id, { ...map.get(draft.id), ...draft, draft: true });
    historyNotes = [...map.values()].sort((a, b) => b.day.localeCompare(a.day) || b.created_at.localeCompare(a.created_at) || a.id.localeCompare(b.id));
    const selected = $('tag-filter').value; $('tag-filter').replaceChildren();
    const all = document.createElement('option'); all.value = ''; all.textContent = 'すべてのタグ'; $('tag-filter').append(all);
    for (const tag of [...new Set([...tags, ...historyNotes.flatMap(note => note.tags)])]) { const option = document.createElement('option'); option.value = tag; option.textContent = tag; $('tag-filter').append(option); }
    $('tag-filter').value = selected; $('tag-filter').hidden = !$('tag-filter').options.length || $('tag-filter').options.length === 1;
    renderList();
  } catch (error) { $('list-status').textContent = ''; $('history-error').textContent = message(error); $('history-error').hidden = false; $('list-retry').hidden = false; }
}
$('search').addEventListener('input', () => { clearTimeout(searchTimer); searchTimer = setTimeout(() => { shown = 30; renderList(); }, 150); });
$('search-form').addEventListener('submit', event => { event.preventDefault(); clearTimeout(searchTimer); shown = 30; renderList(); });
$('tag-filter').addEventListener('change', () => { shown = 30; renderList(); });
$('list-retry').addEventListener('click', loadHistory);
$('load-more').addEventListener('click', () => { shown += 30; renderList(); });

function download(content, filename, type = 'text/markdown;charset=utf-8') {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const a = document.createElement('a'); a.href = url; a.download = filename; document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 30000);
}
function exportCurrent() { download(toMarkdown([{ day: activeDay, body: editor.value, tags: selectedTags, created_at: createdAt }]), `${activeDay}-${activeId.replace(/[^\w-]/g, '').slice(0, 12)}.md`); }
$('export-note').addEventListener('click', exportCurrent); $('copy-button').addEventListener('click', exportCurrent);
$('export-all').addEventListener('click', async () => {
  const button = $('export-all'); button.disabled = true;
  try { download(toMarkdown(await getAllNotes()), 'hitokoto-notes.md'); }
  catch (error) { $('history-error').textContent = message(error); $('history-error').hidden = false; }
  finally { button.disabled = false; }
});
async function exportJson(button) {
  button.disabled = true;
  try {
    const [notes, tags] = await Promise.all([getAllNotes(), getAllTags()]);
    download(createBackup(notes, tags), `hitokoto-${dayKey()}.json`, 'application/json;charset=utf-8');
    if (!$('history-view').hidden) $('list-status').textContent = '保存済みメモと登録済みタグをJSONに書き出しました';
    else $('save-status').textContent = dirty() ? 'JSONを書き出しました · 書きかけは未保存です' : 'JSONを書き出しました';
  } catch (error) {
    if (!$('history-view').hidden) { $('history-error').textContent = message(error); $('history-error').hidden = false; }
    else setError(message(error));
  }
  finally { button.disabled = false; }
}
for (const id of ['export-json', 'export-json-editor']) $(id).addEventListener('click', () => exportJson($(id)));
$('import-json').addEventListener('click', () => $('import-file').click());
$('import-file').addEventListener('change', async () => {
  const file = $('import-file').files[0]; $('import-file').value = ''; if (!file) return;
  try {
    if (file.size > MAX_BACKUP_BYTES) throw new Error('JSONファイルは20MB以内で読み込んでください。');
    const backup = parseBackup(await file.text());
    if (!backup.notes.length && !backup.tags.length) throw new Error('このファイルにはメモやタグがありません。');
    const ids = new Set((await getAllNotes()).map(note => note.id));
    const duplicates = backup.notes.filter(note => ids.has(note.id)).length;
    pendingImport = backup;
    $('import-summary').textContent = `メモ ${backup.notes.length}件（新規 ${backup.notes.length - duplicates}件・同じノート ${duplicates}件）、タグ ${backup.tags.length}個。`;
    $('overwrite').checked = false; $('overwrite-option').hidden = !duplicates;
    $('import-policy').textContent = '同じノートはこの端末の本文を残します。同じ日の別ノートは追加します。';
    $('import-dialog-error').hidden = true; $('confirm-import').disabled = false; $('import-dialog').showModal(); $('cancel-import').focus();
  } catch (error) { $('history-error').textContent = message(error); $('history-error').hidden = false; }
});
$('cancel-import').addEventListener('click', () => $('import-dialog').close());
$('import-dialog').addEventListener('close', () => { pendingImport = null; });
$('overwrite').addEventListener('change', () => { $('import-policy').textContent = $('overwrite').checked ? '同じノートの本文とタグを置き換えます。必要な場合は先にJSONを書き出してください。' : '同じノートはこの端末の本文を残します。同じ日の別ノートは追加します。'; });
$('confirm-import').addEventListener('click', async () => {
  if (!pendingImport) return;
  const button = $('confirm-import'); button.disabled = true; button.textContent = '読み込み中…'; $('cancel-import').disabled = true;
  preserveDraft();
  try {
    const result = await importNotes(pendingImport.notes, $('overwrite').checked, pendingImport.tags);
    $('import-dialog').close(); await loadEntry(activeId, false); showView('history'); await loadHistory();
    $('list-status').textContent = `読み込みました · 追加 ${result.added}件、置換 ${result.replaced}件、既存を維持 ${result.skipped}件`;
  } catch (error) { $('import-dialog-error').textContent = '読み込みを保存できませんでした。元のメモは変更していません。'; $('import-dialog-error').hidden = false; }
  finally { button.disabled = false; button.textContent = '読み込む'; $('cancel-import').disabled = false; }
});
$('delete-button').addEventListener('click', () => {
  $('delete-date').textContent = formatDay(activeDay) + (savedNote ? ` ${formatTime(savedNote.created_at)}` : ' · 書きかけ');
  $('confirm-delete').disabled = false; $('delete-dialog').showModal(); $('cancel-delete').focus();
});
$('cancel-delete').addEventListener('click', () => $('delete-dialog').close());
$('confirm-delete').addEventListener('click', async () => {
  const button = $('confirm-delete'); button.disabled = true; busy = true; controls();
  try {
    if (savedNote) await deleteNote(activeId, savedNote.revision);
    removeDraft(activeId); editor.value = ''; baseBody = ''; baseTags = []; selectedTags = []; savedNote = null; revision = null;
    $('delete-dialog').close(); setError(); busy = false; newNote(); showView('history'); await loadHistory();
  } catch (error) { $('delete-dialog').close(); setError(message(error), error.status === 409); }
  finally { busy = false; button.disabled = false; controls(); }
});
$('latest-button').addEventListener('click', async () => {
  const button = $('latest-button'); button.disabled = true;
  try {
    const latest = await getNote(activeId);
    const dialog = document.createElement('dialog'), heading = document.createElement('h2'); heading.textContent = latest ? '最新のメモ' : 'このメモは削除されています';
    const text = document.createElement('textarea'); text.className = 'latest-note'; text.readOnly = true; text.value = latest?.body ?? ''; text.setAttribute('aria-label', '最新のメモ本文');
    const tags = document.createElement('p'); tags.className = 'dialog-caption'; tags.textContent = latest?.tags.join('、') ?? '';
    const actions = document.createElement('div'); actions.className = 'dialog-actions';
    const cancel = document.createElement('button'); cancel.className = 'secondary'; cancel.textContent = '戻る'; cancel.addEventListener('click', () => dialog.close());
    const merge = document.createElement('button'); merge.className = 'primary'; merge.textContent = latest ? '書きかけを追加' : '書きかけを使う';
    merge.addEventListener('click', () => {
      const tags = [...new Set([...(latest?.tags ?? []), ...selectedTags])];
      if (tags.length > 20) { setError('タグが20個を超えています。不要なタグを外してからお試しください。', true); dialog.close(); return; }
      editor.value = latest ? `${latest.body}\n\n${editor.value}` : editor.value;
      selectedTags = tags; savedNote = latest; baseBody = latest?.body ?? ''; baseTags = latest?.tags ?? []; revision = latest?.revision ?? null;
      renderTags(); changed(); setError(); dialog.close(); editor.focus({ preventScroll: true });
    });
    actions.append(cancel, merge); dialog.append(heading, text, tags, actions); document.body.append(dialog); dialog.addEventListener('close', () => dialog.remove(), { once: true }); dialog.showModal(); cancel.focus();
  } catch (error) { setError(message(error), conflicting); }
  finally { button.disabled = false; }
});
window.addEventListener('pagehide', preserveDraft);
document.addEventListener('visibilitychange', () => { if (document.hidden) preserveDraft(); });
window.addEventListener('beforeunload', event => { preserveDraft(); if (storageProblem && dirty()) { event.preventDefault(); event.returnValue = ''; } });
window.addEventListener('storage', event => { if (event.key === PREFIX + activeId && event.newValue && readDraft(activeId)?.body !== editor.value) setError('別のタブにも書きかけがあります。必要な本文を書き出してから保存してください。'); });
setInterval(() => { if (!savedNote && !dirty() && activeDay !== dayKey()) { activeDay = dayKey(); updateHeading(); } }, 60000);
migrateDrafts();
let restore;
try { restore = localStorage.getItem(ACTIVE); } catch {}
if (restore && readDraft(restore)) loadEntry(restore);
else { const drafts = allDrafts().sort((a, b) => b.updated_at.localeCompare(a.updated_at)); if (drafts.length) loadEntry(drafts[0].id); else newNote(); }
if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
