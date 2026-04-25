import { fetchSupabasePeopleRows } from './supabase/people-store.js';
import { fetchYandexPeopleRows } from './yandex/people-store.js';

export async function fetchRemotePeopleRows(source) {
  return source === 'yandex'
    ? fetchYandexPeopleRows()
    : fetchSupabasePeopleRows();
}
