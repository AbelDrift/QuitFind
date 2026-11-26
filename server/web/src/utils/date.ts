import { useStore } from '@/lib/store';

export function formatDateTime(date: number | string | Date) {
  let { language } = useStore.getState();
  return new Date(date).toLocaleString(language);
}
