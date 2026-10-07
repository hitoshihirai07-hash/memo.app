export function dayKey(date = new Date()) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}
export function validDay(day) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || day < '1900-01-01' || day > '9999-12-31') return false;
  const date = new Date(`${day}T12:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === day;
}
export function toMarkdown(notes) {
  return [...notes].sort((a, b) => a.day.localeCompare(b.day) || (a.created_at ?? '').localeCompare(b.created_at ?? '')).map(note => `# ${note.day}${note.created_at ? ' ' + formatTime(note.created_at) : ''}\n\n${note.tags?.length ? 'タグ: ' + note.tags.join('、') + '\n\n' : ''}${note.body}\n`).join('\n---\n\n');
}
export function formatTime(time) {
  return new Intl.DateTimeFormat('ja-JP', { hour: '2-digit', minute: '2-digit' }).format(new Date(time));
}
export function normalizeTags(tags = []) {
  if (!Array.isArray(tags) || tags.length > 20) throw new Error('タグは1件につき20個まで追加できます。');
  const result = [];
  for (const tag of tags) {
    if (typeof tag !== 'string') throw new Error('タグは文字で入力してください。');
    const name = tag.trim().replace(/^#/, '').trim();
    if (!name || name.length > 30 || /[\u0000-\u001f\u007f]/.test(name)) throw new Error('タグは1〜30文字で入力してください。');
    if (!result.includes(name)) result.push(name);
  }
  return result;
}
export function formatDay(day) {
  return new Intl.DateTimeFormat('ja-JP', { year: 'numeric', month: 'long', day: 'numeric', weekday: 'long' }).format(new Date(`${day}T12:00:00`));
}
