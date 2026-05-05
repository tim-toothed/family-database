import { buildFamilyColorTheme } from './family-colors.js';
import {
  getBirthNameParts,
  getBirthYear,
  getDatasetPersonName,
  getExistingRelationPersonIds,
  hasUnknownSurname,
  isPersonIdFallbackName,
  getPersonSex,
  getRelationEntries,
} from '../person/model.js';
import { normalizeText } from '../utils/normalize.js';

function getSexLabel(person) {
  return getPersonSex(person);
}

function getChildIds(person, people) {
  return getExistingRelationPersonIds(person, 'children', people);
}

function getParentIds(person, people) {
  return getExistingRelationPersonIds(person, 'parents', people);
}

function getSpouseIds(person, people) {
  return getExistingRelationPersonIds(person, 'spouses', people);
}

function getSiblingIds(person, people) {
  return getExistingRelationPersonIds(person, 'siblings', people);
}

function compareStringsAsc(left, right) {
  return String(left ?? '').localeCompare(String(right ?? ''), 'ru');
}

function getPersonNameTailSortBucket(personId, person, dataset) {
  const displayName = getDatasetPersonName(dataset, personId, personId);

  if (isPersonIdFallbackName(displayName)) return 2;
  if (hasUnknownSurname(person)) return 1;
  return 0;
}

function comparePeopleNamesAsc(leftId, rightId, dataset, tableData) {
  const left = dataset.people.get(leftId) || {};
  const right = dataset.people.get(rightId) || {};
  const leftBirthName = getBirthNameParts(left);
  const rightBirthName = getBirthNameParts(right);
  const leftSortBucket = getPersonNameTailSortBucket(leftId, left, dataset);
  const rightSortBucket = getPersonNameTailSortBucket(rightId, right, dataset);

  if (leftSortBucket !== rightSortBucket) {
    return leftSortBucket - rightSortBucket;
  }

  const leftFamilyId = tableData.familyIdByPerson.get(leftId) ?? Number.MAX_SAFE_INTEGER;
  const rightFamilyId = tableData.familyIdByPerson.get(rightId) ?? Number.MAX_SAFE_INTEGER;
  if (leftFamilyId !== rightFamilyId) return leftFamilyId - rightFamilyId;

  const firstNameCompare = compareStringsAsc(leftBirthName.firstName, rightBirthName.firstName);
  if (firstNameCompare !== 0) return firstNameCompare;

  const patronymicCompare = compareStringsAsc(leftBirthName.patronymic, rightBirthName.patronymic);
  if (patronymicCompare !== 0) return patronymicCompare;

  const displayNameCompare = compareStringsAsc(
    getDatasetPersonName(dataset, leftId, leftId),
    getDatasetPersonName(dataset, rightId, rightId)
  );
  if (displayNameCompare !== 0) return displayNameCompare;

  return compareStringsAsc(leftId, rightId);
}

function compareChildIds(leftId, rightId, dataset, tableData) {
  const leftYear = getBirthYear(dataset.people.get(leftId));
  const rightYear = getBirthYear(dataset.people.get(rightId));

  if (leftYear == null && rightYear != null) return 1;
  if (leftYear != null && rightYear == null) return -1;
  if (leftYear != null && rightYear != null && leftYear !== rightYear) {
    return leftYear - rightYear;
  }

  return comparePeopleNamesAsc(leftId, rightId, dataset, tableData);
}

function pairKey(leftId, rightId) {
  return [leftId, rightId].sort().join('|');
}

function getSharedChildIds(dataset, leftId, rightId, tableData) {
  const leftChildren = new Set(getChildIds(dataset.people.get(leftId), dataset.people));
  const rightChildren = new Set(getChildIds(dataset.people.get(rightId), dataset.people));

  return Array.from(leftChildren)
    .filter((childId) => rightChildren.has(childId))
    .sort((a, b) => compareChildIds(a, b, dataset, tableData));
}

function buildCandidatePairs(dataset) {
  const pairKeys = new Set();

  for (const [personId, person] of dataset.people.entries()) {
    for (const spouseId of getSpouseIds(person, dataset.people)) {
      pairKeys.add(pairKey(personId, spouseId));
    }

    const parentIds = getParentIds(person, dataset.people);
    if (parentIds.length < 2) continue;

    for (let index = 0; index < parentIds.length - 1; index += 1) {
      for (let otherIndex = index + 1; otherIndex < parentIds.length; otherIndex += 1) {
        pairKeys.add(pairKey(parentIds[index], parentIds[otherIndex]));
      }
    }
  }

  return Array.from(pairKeys)
    .sort()
    .map((value) => value.split('|'));
}

function orderParentIds(dataset, leftId, rightId, childIds) {
  const leftSex = getSexLabel(dataset.people.get(leftId));
  const rightSex = getSexLabel(dataset.people.get(rightId));

  if (leftSex === 'м' && rightSex !== 'м') return [leftId, rightId];
  if (rightSex === 'м' && leftSex !== 'м') return [rightId, leftId];
  if (leftSex === 'ж' && rightSex !== 'ж') return [rightId, leftId];
  if (rightSex === 'ж' && leftSex !== 'ж') return [leftId, rightId];

  const childParentHints = childIds.flatMap((childId) => getRelationEntries(dataset.people.get(childId), 'parents'));
  const leftScore = childParentHints.filter((item) => item.personId === leftId && normalizeText(item.relationType).includes('отец')).length;
  const rightScore = childParentHints.filter((item) => item.personId === rightId && normalizeText(item.relationType).includes('отец')).length;
  if (leftScore !== rightScore) return leftScore > rightScore ? [leftId, rightId] : [rightId, leftId];

  return compareStringsAsc(leftId, rightId) <= 0 ? [leftId, rightId] : [rightId, leftId];
}

function appendMaleGenitive(value) {
  const text = String(value || '').trim();
  if (!text || /[?()]/.test(text)) return text;
  const lower = text.toLowerCase();

  if (lower.endsWith('ский')) return `${text.slice(0, -4)}ского`;
  if (lower.endsWith('цкий')) return `${text.slice(0, -4)}цкого`;
  if (lower.endsWith('ой')) return `${text.slice(0, -2)}ого`;
  if (lower.endsWith('ий')) return `${text.slice(0, -2)}его`;
  if (lower.endsWith('ёв')) return `${text}а`;
  if (lower.endsWith('ев')) return `${text}а`;
  if (lower.endsWith('ов')) return `${text}а`;
  if (lower.endsWith('ин')) return `${text}а`;
  if (lower.endsWith('ын')) return `${text}а`;
  if (/[бвгджзйклмнпрстфхцчшщь]$/i.test(text)) {
    if (lower.endsWith('й') || lower.endsWith('ь')) return `${text.slice(0, -1)}я`;
    return `${text}а`;
  }

  return text;
}

function inflectMaleFirstName(value) {
  const text = String(value || '').trim();
  if (!text || /[?()]/.test(text)) return text;
  const lower = text.toLowerCase();

  if (lower.endsWith('й') || lower.endsWith('ь')) return `${text.slice(0, -1)}я`;
  if (lower.endsWith('я')) return `${text.slice(0, -1)}и`;
  if (lower.endsWith('а')) {
    const prev = lower.slice(-2, -1);
    return `${text.slice(0, -1)}${/[гкхжчшщ]/.test(prev) ? 'и' : 'ы'}`;
  }
  if (/[бвгджзклмнпрстфхцчшщ]$/i.test(text)) return `${text}а`;

  return text;
}

function inflectPatronymic(value) {
  const text = String(value || '').trim();
  if (!text || /[?()]/.test(text)) return text;
  const lower = text.toLowerCase();

  if (lower.endsWith('ич')) return `${text}а`;
  if (lower.endsWith('на')) return `${text.slice(0, -1)}ы`;
  return text;
}

function buildFamilyTitle(dataset, ownerId) {
  if (!ownerId || !dataset.people.has(ownerId)) {
    return 'Семья';
  }

  const person = dataset.people.get(ownerId);
  const birthName = getBirthNameParts(person);
  const sex = getSexLabel(person);
  const originalName = getDatasetPersonName(dataset, ownerId, ownerId);

  if (sex !== 'м') {
    return `Семья ${originalName}`;
  }

  const surname = appendMaleGenitive(birthName.surname);
  const firstName = inflectMaleFirstName(birthName.firstName);
  const patronymic = inflectPatronymic(birthName.patronymic);
  const inflected = [surname, firstName, patronymic].filter(Boolean).join(' ').trim();

  return `Семья ${inflected || originalName}`;
}

function getRoleToneBySex(person) {
  const sex = getSexLabel(person);
  if (sex === 'м') return 'male';
  if (sex === 'ж') return 'female';
  return 'neutral';
}

function makeMember(personId, roleLabel, roleTone, dataset, tableData) {
  return {
    personId,
    fullName: getDatasetPersonName(dataset, personId, personId),
    generationId: tableData.generationByPerson.get(personId) ?? null,
    roleLabel,
    roleTone,
  };
}

function describeUngroupedChildRelation(personId, dataset, tableData) {
  const parentIds = getParentIds(dataset.people.get(personId), dataset.people)
    .sort((leftId, rightId) => comparePeopleNamesAsc(leftId, rightId, dataset, tableData));

  if (!parentIds.length) return null;

  const sex = getSexLabel(dataset.people.get(personId));
  const relation = sex === 'ж' ? 'дочь' : sex === 'м' ? 'сын' : 'ребёнок';
  const referenceName = getDatasetPersonName(dataset, parentIds[0], parentIds[0]);

  return {
    roleLabel: `${relation} по отн. к ${referenceName}`,
    roleTone: getRoleToneBySex(dataset.people.get(personId)),
  };
}

function describeUngroupedSiblingRelation(personId, dataset, tableData) {
  const siblingIds = getSiblingIds(dataset.people.get(personId), dataset.people)
    .sort((leftId, rightId) => comparePeopleNamesAsc(leftId, rightId, dataset, tableData));

  if (!siblingIds.length) return null;

  const sex = getSexLabel(dataset.people.get(personId));
  const relation = sex === 'ж' ? 'сестра' : sex === 'м' ? 'брат' : 'сиблинг';
  const referenceName = getDatasetPersonName(dataset, siblingIds[0], siblingIds[0]);

  return {
    roleLabel: `${relation} по отн. к ${referenceName}`,
    roleTone: getRoleToneBySex(dataset.people.get(personId)),
  };
}

function describeUngroupedSpouseRelation(personId, dataset, tableData) {
  const spouseIds = getSpouseIds(dataset.people.get(personId), dataset.people)
    .sort((leftId, rightId) => comparePeopleNamesAsc(leftId, rightId, dataset, tableData));

  if (!spouseIds.length) return null;

  const sex = getSexLabel(dataset.people.get(personId));
  const relation = sex === 'ж'
    ? 'другая супруга'
    : sex === 'м'
      ? 'другой супруг'
      : 'другой супруг(а)';
  const referenceName = getDatasetPersonName(dataset, spouseIds[0], spouseIds[0]);

  return {
    roleLabel: `${relation} по отн. к ${referenceName}`,
    roleTone: getRoleToneBySex(dataset.people.get(personId)),
  };
}

function describeUngroupedRelation(personId, dataset, tableData) {
  return describeUngroupedChildRelation(personId, dataset, tableData)
    || describeUngroupedSiblingRelation(personId, dataset, tableData)
    || describeUngroupedSpouseRelation(personId, dataset, tableData)
    || { roleLabel: '', roleTone: getRoleToneBySex(dataset.people.get(personId)) };
}

function buildParentMembers(dataset, tableData, fatherId, motherId) {
  const members = [];

  if (fatherId) {
    members.push(makeMember(fatherId, 'отец', 'male', dataset, tableData));
  }

  if (motherId) {
    const motherSex = getSexLabel(dataset.people.get(motherId));
    members.push(makeMember(
      motherId,
      motherSex === 'м' ? 'отец' : 'мать',
      motherSex === 'м' ? 'male' : 'female',
      dataset,
      tableData
    ));
  }

  return members;
}

function buildChildMembers(childIds, dataset, tableData) {
  return childIds.map((childId) => {
    const sex = getSexLabel(dataset.people.get(childId));
    if (sex === 'м') {
      return makeMember(childId, 'сын', 'male', dataset, tableData);
    }
    if (sex === 'ж') {
      return makeMember(childId, 'дочь', 'female', dataset, tableData);
    }
    return makeMember(childId, 'ребёнок', 'neutral', dataset, tableData);
  });
}

function compareFamilyVariant(left, right, dataset, tableData) {
  const leftMotherName = left.motherId ? getDatasetPersonName(dataset, left.motherId, left.motherId) : '';
  const rightMotherName = right.motherId ? getDatasetPersonName(dataset, right.motherId, right.motherId) : '';
  const motherCompare = compareStringsAsc(leftMotherName, rightMotherName);
  if (motherCompare !== 0) return motherCompare;

  const leftOldestChildYear = left.oldestChildYear ?? Number.MAX_SAFE_INTEGER;
  const rightOldestChildYear = right.oldestChildYear ?? Number.MAX_SAFE_INTEGER;
  if (leftOldestChildYear !== rightOldestChildYear) return leftOldestChildYear - rightOldestChildYear;

  const leftFirstChildId = left.childIds[0] || '';
  const rightFirstChildId = right.childIds[0] || '';
  const childCompare = comparePeopleNamesAsc(leftFirstChildId, rightFirstChildId, dataset, tableData);
  if (childCompare !== 0) return childCompare;

  return compareStringsAsc(left.id, right.id);
}

function assignGroupTitles(groups, dataset, tableData) {
  const byOwner = new Map();

  for (const group of groups) {
    const ownerId = group.titleOwnerId || group.fatherId || group.motherId || group.parentIds[0] || group.id;
    if (!byOwner.has(ownerId)) byOwner.set(ownerId, []);
    byOwner.get(ownerId).push(group);
  }

  for (const [ownerId, ownerGroups] of byOwner.entries()) {
    ownerGroups.sort((left, right) => compareFamilyVariant(left, right, dataset, tableData));
    const baseTitle = buildFamilyTitle(dataset, ownerId);

    ownerGroups.forEach((group, index) => {
      group.title = index === 0 ? baseTitle : `${baseTitle} (${index + 1})`;
      group.sortTitle = group.title;
    });
  }
}

function buildFamilyGroup(pairIds, childIds, dataset, tableData) {
  const [firstParentId, secondParentId] = orderParentIds(dataset, pairIds[0], pairIds[1], childIds);
  const firstParentSex = getSexLabel(dataset.people.get(firstParentId));
  const secondParentSex = getSexLabel(dataset.people.get(secondParentId));
  const fatherId = firstParentSex === 'м'
    ? firstParentId
    : secondParentSex === 'м'
      ? secondParentId
      : firstParentId;
  const motherId = fatherId === firstParentId ? secondParentId : firstParentId;
  const groupId = `family:${pairKey(pairIds[0], pairIds[1])}`;
  const theme = buildFamilyColorTheme(dataset, tableData, {
    branchPersonId: fatherId || firstParentId || motherId,
    personIds: [fatherId, motherId].filter(Boolean),
    variantKey: groupId,
  });
  const childMembers = buildChildMembers(childIds, dataset, tableData);
  const parentMembers = buildParentMembers(dataset, tableData, fatherId, motherId);
  const parentGenerations = [fatherId, motherId]
    .map((personId) => tableData.generationByPerson.get(personId))
    .filter((value) => value != null);
  const childGenerations = childIds
    .map((personId) => tableData.generationByPerson.get(personId))
    .filter((value) => value != null);
  const oldestChildYear = childIds
    .map((childId) => getBirthYear(dataset.people.get(childId)))
    .filter((value) => value != null)
    .sort((a, b) => a - b)[0] ?? null;

  return {
    id: groupId,
    kind: 'family',
    parentIds: [fatherId, motherId].filter(Boolean),
    fatherId,
    motherId,
    childIds,
    titleOwnerId: fatherId || firstParentId,
    title: '',
    sortTitle: '',
    generationId: parentGenerations[0] ?? childGenerations[0] ?? null,
    color: theme.color,
    softColor: theme.softColor,
    headerColor: theme.headerColor,
    branchColor: theme.branchColor,
    branchId: theme.branchId,
    oldestChildYear,
    members: [...parentMembers, ...childMembers],
  };
}

function buildUngroupedGroup(dataset, tableData, groupedPeopleIds) {
  const ungroupedIds = Array.from(dataset.people.keys())
    .filter((personId) => !groupedPeopleIds.has(personId))
    .sort((a, b) => comparePeopleNamesAsc(a, b, dataset, tableData));

  if (!ungroupedIds.length) return null;

  return {
    id: 'ungrouped',
    kind: 'ungrouped',
    parentIds: [],
    fatherId: null,
    motherId: null,
    childIds: [],
    titleOwnerId: null,
    title: 'Прочие люди',
    sortTitle: 'Прочие люди',
    generationId: null,
    ...buildFamilyColorTheme(dataset, tableData, { neutral: true }),
    oldestChildYear: null,
    members: ungroupedIds.map((personId) => {
      const relationDescription = describeUngroupedRelation(personId, dataset, tableData);
      return makeMember(
        personId,
        relationDescription.roleLabel,
        relationDescription.roleTone,
        dataset,
        tableData
      );
    }),
  };
}

export function buildFamilyGroups(dataset, tableData) {
  const groupedPeopleIds = new Set();
  const groups = [];

  for (const pairIds of buildCandidatePairs(dataset)) {
    const childIds = getSharedChildIds(dataset, pairIds[0], pairIds[1], tableData);
    if (!childIds.length) continue;

    const group = buildFamilyGroup(pairIds, childIds, dataset, tableData);
    groups.push(group);

    group.parentIds.forEach((personId) => groupedPeopleIds.add(personId));
    childIds.forEach((personId) => groupedPeopleIds.add(personId));
  }

  assignGroupTitles(groups, dataset, tableData);

  const ungroupedGroup = buildUngroupedGroup(dataset, tableData, groupedPeopleIds);
  if (ungroupedGroup) {
    groups.push(ungroupedGroup);
  }

  return {
    groups,
  };
}

function compareNullableGeneration(left, right) {
  const leftValue = left ?? Number.NEGATIVE_INFINITY;
  const rightValue = right ?? Number.NEGATIVE_INFINITY;
  if (left == null && right == null) return 0;
  if (left == null) return 1;
  if (right == null) return -1;
  return leftValue - rightValue;
}

export function sortFamilyGroups(groups, sortMode) {
  const regularGroups = groups.filter((group) => group.kind !== 'ungrouped');
  const ungroupedGroups = groups.filter((group) => group.kind === 'ungrouped');

  regularGroups.sort((left, right) => {
    if (sortMode === 'alphabet-desc') {
      const titleCompare = compareStringsAsc(right.sortTitle, left.sortTitle);
      if (titleCompare !== 0) return titleCompare;
      return compareNullableGeneration(right.generationId, left.generationId);
    }

    if (sortMode === 'alphabet-asc') {
      const titleCompare = compareStringsAsc(left.sortTitle, right.sortTitle);
      if (titleCompare !== 0) return titleCompare;
      return compareNullableGeneration(left.generationId, right.generationId);
    }

    if (sortMode === 'generation-asc') {
      const generationCompare = compareNullableGeneration(left.generationId, right.generationId);
      if (generationCompare !== 0) return generationCompare;
      return compareStringsAsc(left.sortTitle, right.sortTitle);
    }

    const generationCompare = compareNullableGeneration(right.generationId, left.generationId);
    if (generationCompare !== 0) return generationCompare;
    return compareStringsAsc(left.sortTitle, right.sortTitle);
  });

  return [...regularGroups, ...ungroupedGroups];
}
