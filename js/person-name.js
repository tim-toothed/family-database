export function formatBirthName(birthName) {
  if (typeof birthName === 'string') {
    return birthName.trim();
  }

  if (!birthName || typeof birthName !== 'object') {
    return '';
  }

  return [
    birthName.first_name,
    birthName.second_name,
    birthName.patronymic,
  ]
    .map((part) => String(part ?? '').trim())
    .filter(Boolean)
    .join(' ');
}

export function getPersonDisplayName(person, fallback = '') {
  return formatBirthName(person?.birth_name) || String(fallback ?? '').trim();
}

export function getDatasetPersonName(dataset, personId, fallback = null) {
  if (!personId) return String(fallback ?? '');

  return dataset?.indexById?.get(personId)
    || getPersonDisplayName(dataset?.people?.get(personId), fallback ?? personId);
}
