export function dayKey(date = new Date()) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}
export function validDay(day) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || day < '1900-01-01' || day > '9999-12-31') return false;
  const date = new Date(`${day}T12:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === day;
}
export function toMarkdown(notes) {
  return [...notes].sort((a, b) => a.day.localeCompare(b.day)).map(note => `# ${note.day}\n\n${note.body}\n`).join('\n---\n\n');
}
export function formatDay(day) {
  return new Intl.DateTimeFormat('ja-JP', { year: 'numeric', month: 'long', day: 'numeric', weekday: 'long' }).format(new Date(`${day}T12:00:00`));
}
