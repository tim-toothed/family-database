import { fetchYandexDbApi } from './client.js';

export async function loadPeopleIndex() {
  const payload = await fetchYandexDbApi('/people-index');
  return new Map(
    (Array.isArray(payload?.rows) ? payload.rows : []).map((row) => [
      String(row.id || '').trim(),
      String(row.display_name || row.id || '').trim(),
    ])
  );
}

export async function loadEditablePerson(personId) {
  const payload = await fetchYandexDbApi(`/people/${encodeURIComponent(personId)}`);
  return payload?.payload || null;
}

export async function saveEditablePerson(personId, payload) {
  return fetchYandexDbApi(`/people/${encodeURIComponent(personId)}`, {
    method: 'PUT',
    body: { payload },
  });
}

export async function createEditablePerson(personId, payload) {
  return fetchYandexDbApi(`/people/${encodeURIComponent(personId)}`, {
    method: 'POST',
    body: { payload },
  });
}
