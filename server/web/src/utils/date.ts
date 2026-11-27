import { useStore } from '@/lib/store';

export function formatDateTime(date: number | string | Date) {
  let { language } = useStore.getState();
  return new Date(date).toLocaleString(language);
}

// QuitFind: "5 minutes ago" in the UI language
export function formatRelative(date: number) {
  const { language } = useStore.getState();
  const rtf = new Intl.RelativeTimeFormat(language, { numeric: 'auto' });
  const seconds = Math.round((date - Date.now()) / 1000);
  for (const [unit, size] of [
    ['day', 86400],
    ['hour', 3600],
    ['minute', 60],
  ] as const) {
    if (Math.abs(seconds) >= size) return rtf.format(Math.round(seconds / size), unit);
  }
  return rtf.format(seconds, 'second');
}
