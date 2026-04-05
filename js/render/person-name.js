import {
  formatBirthName,
  getPersonDisplayName,
} from '../person/model.js';

export { formatBirthName, getPersonDisplayName };

export function getDatasetPersonName(dataset, personId, fallback = null) {
  if (!personId) return String(fallback ?? '');

  return dataset?.indexById?.get(personId)
    || getPersonDisplayName(dataset?.people?.get(personId), fallback ?? personId);
}
