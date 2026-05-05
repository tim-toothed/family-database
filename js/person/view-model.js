import { getPersonFieldLabel, PERSON_SECTION_ORDER } from './labels.js';
import {
  getDatasetPersonName,
  getLifeEvent,
  getPersonDisplayName,
  personHasField,
} from './model.js';

export const PERSON_SECTION_VIEW_TEMPLATES = {
  birth_name: { type: 'custom', name: 'birthName' },
  name_changes: { type: 'cleanList' },
  birth: { type: 'cleanList', event: true },
  death: { type: 'cleanList', event: true },
  parents: { type: 'relationsList' },
  siblings: { type: 'relationsList' },
  children: { type: 'relationsList' },
  spouses: { type: 'custom', name: 'spouses' },
  education: { type: 'bulletList' },
  jobs: { type: 'bulletList' },
  military_service: { type: 'bulletList' },
  war_participation: { type: 'bulletList' },
  achievements: { type: 'bulletList' },
  residences: { type: 'bulletList' },
  sources: { type: 'bulletList', valueType: 'markdownLink' },
  media: { type: 'custom', name: 'media' },
  other_info: {
    type: 'cleanList',
    namedText: true,
    baseKey: 'other_info',
    labelPrefix: 'Other info',
    singleUnlabeledAsText: true,
  },
};

export function getPersonSectionViewTemplate(sectionKey) {
  return PERSON_SECTION_VIEW_TEMPLATES[sectionKey] || { type: 'cleanText' };
}

export function buildPersonSectionViews(person) {
  const sections = [];

  for (const key of PERSON_SECTION_ORDER) {
    if (!personHasField(person, key)) continue;
    sections.push({
      key,
      label: getPersonFieldLabel(key, { context: 'view' }),
      value: person[key],
      template: getPersonSectionViewTemplate(key),
    });
  }

  return sections;
}

export function buildPersonDetailsModel(personId, dataset, options = {}) {
  const person = options.personOverride || dataset.people.get(personId);
  if (!person) return null;

  const title = options.personOverride
    ? getPersonDisplayName(person, personId)
    : getDatasetPersonName(dataset, personId, personId);

  const subtitleParts = [personId];
  const birth = getLifeEvent(person, 'birth');
  const death = getLifeEvent(person, 'death');
  if (birth.dateDisplay) subtitleParts.push(`рожд. ${birth.dateDisplay}`);
  if (death.dateDisplay) subtitleParts.push(`ум. ${death.dateDisplay}`);

  return {
    title,
    subtitle: subtitleParts.join(' • '),
    sections: buildPersonSectionViews(person),
  };
}
