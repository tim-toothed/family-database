import { fetchYandexDbApi } from './client.js';

export async function fetchYandexPeopleRows() {
  const payload = await fetchYandexDbApi('/people');
  const rows = Array.isArray(payload?.rows) ? payload.rows : [];
  if (!rows.length) {
    throw new Error('В Yandex DB не найдено ни одной карточки.');
  }
  return rows;
}
