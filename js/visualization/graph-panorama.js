import { buildFamilyGroups } from './table-family-groups.js';
import { buildPeopleTableData } from './table-view.js';
import { buildFamilyColorTheme, pickBranchPersonId } from './family-colors.js';
import { getBirthNameParts, getPersonSex, getRelationEntries } from '../person/model.js';
import {
  BaseD3Network,
  comparePeopleIds,
  computeFontSize,
  computeBounds,
  getD3,
  getLifeYears,
  getSexLabel,
  personName,
  wrapText,
} from './graph-shared.js';

const PANORAMA_LAYOUT = {
  cardWidth: 150,
  cardHeight: 84,
  cardGapX: 14,
  cardGapY: 26,
  maxChildrenPerRow: 3,
  boxPaddingX: 22,
  boxPaddingTop: 14,
  boxPaddingBottom: 18,
  boxHeaderHeight: 46,
  familyGapX: 42,
  laneGapY: 74,
  parentToChildrenY: 104,
  childBusGapY: 18,
  generationBandPaddingX: 72,
  generationBandInsetY: 12,
  generationLabelInsetX: 22,
};

const UNKNOWN_GENERATION_KEY = 'unknown';

function average(values) {
  if (!values.length) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function makeLineLink(id, className, x1, y1, x2, y2) {
  return {
    id,
    shape: 'line',
    className,
    x1,
    y1,
    x2,
    y2,
    minX: Math.min(x1, x2),
    maxX: Math.max(x1, x2),
    minY: Math.min(y1, y2),
    maxY: Math.max(y1, y2),
  };
}

function makeCurveLink(id, className, startX, startY, endX, endY) {
  const verticalDistance = endY - startY;
  const controlY1 = startY + Math.max(28, Math.abs(verticalDistance) * 0.32);
  const controlY2 = endY - Math.max(28, Math.abs(verticalDistance) * 0.32);
  const d = `M ${startX} ${startY} C ${startX} ${controlY1} ${endX} ${controlY2} ${endX} ${endY}`;

  return {
    id,
    shape: 'path',
    className,
    d,
    minX: Math.min(startX, endX),
    maxX: Math.max(startX, endX),
    minY: Math.min(startY, endY, controlY1, controlY2),
    maxY: Math.max(startY, endY, controlY1, controlY2),
  };
}

function uniqueExistingRelationIds(items, people) {
  const seen = new Set();
  const ids = [];

  for (const item of items || []) {
    const personId = item?.personId ?? item?.person_id;
    if (!personId || personId === '???' || seen.has(personId) || !people.has(personId)) {
      continue;
    }

    seen.add(personId);
    ids.push(personId);
  }

  return ids;
}

function orderPartnerIds(dataset, personIds) {
  const uniqueIds = Array.from(new Set(personIds)).filter(Boolean);
  if (uniqueIds.length < 2) {
    return uniqueIds;
  }

  return uniqueIds.slice().sort((leftId, rightId) => {
    const leftSex = getPersonSex(dataset.people.get(leftId));
    const rightSex = getPersonSex(dataset.people.get(rightId));

    if (leftSex === 'ж' && rightSex === 'м') return -1;
    if (leftSex === 'м' && rightSex === 'ж') return 1;

    return comparePeopleIds(dataset, leftId, rightId);
  });
}

function familyKey(personIds) {
  return `family:${personIds.slice().sort().join('|')}`;
}

function formatFamilyMeta(unit) {
  if (unit.childIds.length > 0) {
    return `${unit.childIds.length} children`;
  }

  if (unit.kind === 'couple') {
    return 'couple';
  }

  return 'single line';
}

function fallbackFamilyTitle(dataset, parentIds, personId = null) {
  if (parentIds.length === 2) {
    return `${personName(dataset, parentIds[0])} + ${personName(dataset, parentIds[1])}`;
  }

  if (parentIds.length === 1) {
    return personName(dataset, parentIds[0]);
  }

  if (personId) {
    return personName(dataset, personId);
  }

  return 'Family';
}

function compactPersonTitle(dataset, personId) {
  const person = dataset.people.get(personId);
  const birthName = getBirthNameParts(person);
  const surname = String(birthName.surname || '').trim();
  const firstName = String(birthName.firstName || '').trim();
  const patronymic = String(birthName.patronymic || '').trim();

  if (!surname || (!firstName && !patronymic)) {
    return personName(dataset, personId);
  }

  const initials = [firstName, patronymic]
    .filter(Boolean)
    .map((value) => `${value[0]}.`)
    .join('');

  return initials ? `${surname} ${initials}` : surname;
}

function compactCoupleTitle(dataset, personIds) {
  if (personIds.length !== 2) {
    return fallbackFamilyTitle(dataset, personIds);
  }

  return `${compactPersonTitle(dataset, personIds[0])} + ${compactPersonTitle(dataset, personIds[1])}`;
}

function generationKey(generationId) {
  return generationId ?? UNKNOWN_GENERATION_KEY;
}

function generationLabel(generationId) {
  return generationId == null ? '?' : String(generationId);
}

function chunkChildren(childIds) {
  const rows = [];
  for (let index = 0; index < childIds.length; index += PANORAMA_LAYOUT.maxChildrenPerRow) {
    rows.push(childIds.slice(index, index + PANORAMA_LAYOUT.maxChildrenPerRow));
  }
  return rows;
}

function fitPanoramaCardText(fullName, subtitle) {
  const normalizedName = String(fullName || '').trim();
  const normalizedSubtitle = String(subtitle || '').trim();
  const availableWidth = PANORAMA_LAYOUT.cardWidth - 24;
  const availableHeight = PANORAMA_LAYOUT.cardHeight - 28;
  const baseFontSize = Math.min(14, computeFontSize(normalizedName || ''));
  let fallbackLayout = null;

  for (let fontSize = baseFontSize; fontSize >= 10; fontSize -= 1) {
    const lineHeight = fontSize * 1.04;
    const yearsFontSize = Math.max(10, Math.round(fontSize * 0.9));
    const maxLineLength = Math.max(8, Math.floor(availableWidth / (fontSize * 0.56)));
    const nameLines = wrapText(normalizedName, maxLineLength, 3);
    const totalHeight = (nameLines.length * lineHeight)
      + (normalizedSubtitle ? (yearsFontSize * 1.08) + 6 : 0);
    const layout = {
      fontSize,
      subtitleFontSize: yearsFontSize,
      nameLines,
    };

    if (!fallbackLayout) {
      fallbackLayout = layout;
    }

    if (totalHeight <= availableHeight) {
      return layout;
    }
  }

  return fallbackLayout || {
    fontSize: 10,
    subtitleFontSize: 10,
    nameLines: wrapText(normalizedName, 12, 3),
  };
}

function fitPanoramaHeaderText(title, width) {
  const normalizedTitle = String(title || '').trim();
  const availableWidth = Math.max(120, width - 36);
  let fallbackFontSize = 12;

  for (let fontSize = 15; fontSize >= 10; fontSize -= 1) {
    const estimatedWidth = normalizedTitle.length * fontSize * 0.56;
    fallbackFontSize = fontSize;

    if (estimatedWidth <= availableWidth) {
      return fontSize;
    }
  }

  return fallbackFontSize;
}

function rowWidth(count) {
  if (!count) return 0;
  return (count * PANORAMA_LAYOUT.cardWidth) + ((count - 1) * PANORAMA_LAYOUT.cardGapX);
}

function measureUnit(unit) {
  const widestRow = Math.max(
    unit.topRowIds.length,
    ...unit.childRows.map((row) => row.length),
    1
  );

  const contentWidth = rowWidth(widestRow);
  const width = Math.max(228, contentWidth + (PANORAMA_LAYOUT.boxPaddingX * 2));
  const parentsY = PANORAMA_LAYOUT.boxHeaderHeight
    + PANORAMA_LAYOUT.boxPaddingTop
    + (PANORAMA_LAYOUT.cardHeight / 2);
  const childRowCenters = unit.childRows.map((_, index) => (
    parentsY + PANORAMA_LAYOUT.parentToChildrenY + (index * (PANORAMA_LAYOUT.cardHeight + PANORAMA_LAYOUT.cardGapY))
  ));
  const lastRowCenter = childRowCenters.at(-1) ?? parentsY;
  const height = unit.childRows.length
    ? lastRowCenter + (PANORAMA_LAYOUT.cardHeight / 2) + PANORAMA_LAYOUT.boxPaddingBottom
    : parentsY + (PANORAMA_LAYOUT.cardHeight / 2) + PANORAMA_LAYOUT.boxPaddingBottom;

  return {
    width,
    height,
    parentsY,
    childRowCenters,
  };
}

function rowCardCenters(centerX, count) {
  const width = rowWidth(count);
  const startX = centerX - (width / 2) + (PANORAMA_LAYOUT.cardWidth / 2);
  return Array.from({ length: count }, (_, index) => (
    startX + index * (PANORAMA_LAYOUT.cardWidth + PANORAMA_LAYOUT.cardGapX)
  ));
}

function buildGroupMetaLookup(dataset, tableData) {
  const familyGroups = buildFamilyGroups(dataset, tableData);
  const lookup = new Map();

  for (const group of familyGroups.groups || []) {
    if (group.kind !== 'family') continue;

    lookup.set(familyKey(group.parentIds || []), {
      title: group.title,
      color: group.color,
      softColor: group.softColor,
      headerColor: group.headerColor,
      branchColor: group.branchColor,
      branchId: group.branchId,
    });
  }

  return lookup;
}

function buildSpousePairs(dataset) {
  const pairs = [];
  const seen = new Set();

  for (const [personId, person] of dataset.people.entries()) {
    const spouseIds = uniqueExistingRelationIds(getRelationEntries(person, 'spouses'), dataset.people)
      .sort((leftId, rightId) => comparePeopleIds(dataset, leftId, rightId));

    for (const spouseId of spouseIds) {
      const key = [personId, spouseId].sort().join('|');
      if (seen.has(key)) continue;
      seen.add(key);

      pairs.push({
        key,
        personIds: key.split('|'),
      });
    }
  }

  return pairs;
}

function buildChildFamilyUnits(dataset, tableData, metaLookup) {
  const unitsByKey = new Map();

  for (const [childId, person] of dataset.people.entries()) {
    const parentIds = uniqueExistingRelationIds(getRelationEntries(person, 'parents'), dataset.people)
      .sort((leftId, rightId) => comparePeopleIds(dataset, leftId, rightId))
      .slice(0, 2);

    if (!parentIds.length) continue;

    const key = familyKey(parentIds);
    if (!unitsByKey.has(key)) {
      const orderedParentIds = orderPartnerIds(dataset, parentIds);
      const meta = metaLookup.get(key);
      const theme = meta || buildFamilyColorTheme(dataset, tableData, {
        branchPersonId: pickBranchPersonId(dataset, orderedParentIds),
        personIds: orderedParentIds,
        variantKey: key,
      });
      unitsByKey.set(key, {
        id: key,
        key,
        kind: 'family',
        generationId: parentIds
          .map((personId) => tableData.generationByPerson.get(personId))
          .find((value) => value != null)
          ?? (
            tableData.generationByPerson.get(childId) != null
              ? tableData.generationByPerson.get(childId) - 1
              : null
          ),
        parentIds: orderedParentIds,
        topRowIds: orderedParentIds.slice(),
        childIds: [],
        childRows: [],
        title: meta?.title || fallbackFamilyTitle(dataset, orderedParentIds),
        color: theme.color,
        softColor: theme.softColor,
        headerColor: theme.headerColor,
        branchColor: theme.branchColor,
        branchId: theme.branchId,
      });
    }

    unitsByKey.get(key).childIds.push(childId);
  }

  return Array.from(unitsByKey.values())
    .map((unit) => ({
      ...unit,
      childIds: unit.childIds
        .slice()
        .sort((leftId, rightId) => comparePeopleIds(dataset, leftId, rightId)),
    }))
    .map((unit) => ({
      ...unit,
      childRows: chunkChildren(unit.childIds),
    }));
}

function buildCoupleUnits(dataset, tableData, occupiedFamilyKeys) {
  return buildSpousePairs(dataset)
    .filter((pair) => !occupiedFamilyKeys.has(familyKey(pair.personIds)))
    .map((pair) => {
      const orderedPartnerIds = orderPartnerIds(dataset, pair.personIds);
      const theme = buildFamilyColorTheme(dataset, tableData, {
        branchPersonId: pickBranchPersonId(dataset, orderedPartnerIds),
        personIds: orderedPartnerIds,
        variantKey: pair.key,
      });
      const generationId = pair.personIds
        .map((personId) => tableData.generationByPerson.get(personId))
        .find((value) => value != null)
        ?? null;

      return {
        id: `couple:${pair.key}`,
        key: pair.key,
        kind: 'couple',
        generationId,
        parentIds: orderedPartnerIds,
        topRowIds: orderedPartnerIds.slice(),
        childIds: [],
        childRows: [],
        title: compactCoupleTitle(dataset, orderedPartnerIds),
        color: theme.color,
        softColor: theme.softColor,
        headerColor: theme.headerColor,
        branchColor: theme.branchColor,
        branchId: theme.branchId,
      };
    });
}

function buildSingleUnits(dataset, tableData, coveredPeopleIds) {
  return Array.from(dataset.people.keys())
    .filter((personId) => !coveredPeopleIds.has(personId))
    .sort((leftId, rightId) => comparePeopleIds(dataset, leftId, rightId))
    .map((personId) => {
      const key = `single:${personId}`;
      const theme = buildFamilyColorTheme(dataset, tableData, {
        branchPersonId: personId,
        personIds: [personId],
        variantKey: key,
      });
      return {
        id: key,
        key,
        kind: 'single',
        generationId: tableData.generationByPerson.get(personId) ?? null,
        personIds: [personId],
        parentIds: [],
        topRowIds: [personId],
        childIds: [],
        childRows: [],
        title: fallbackFamilyTitle(dataset, [], personId),
        color: theme.color,
        softColor: theme.softColor,
        headerColor: theme.headerColor,
        branchColor: theme.branchColor,
        branchId: theme.branchId,
      };
    });
}

function compareUnits(left, right, tableData) {
  const leftGeneration = left.generationId ?? Number.MAX_SAFE_INTEGER;
  const rightGeneration = right.generationId ?? Number.MAX_SAFE_INTEGER;
  if (leftGeneration !== rightGeneration) return leftGeneration - rightGeneration;

  const leftAnchorId = left.topRowIds[0] || left.childIds[0] || left.id;
  const rightAnchorId = right.topRowIds[0] || right.childIds[0] || right.id;
  const leftFamilyId = tableData.familyIdByPerson.get(leftAnchorId) ?? Number.MAX_SAFE_INTEGER;
  const rightFamilyId = tableData.familyIdByPerson.get(rightAnchorId) ?? Number.MAX_SAFE_INTEGER;
  if (leftFamilyId !== rightFamilyId) return leftFamilyId - rightFamilyId;

  return left.title.localeCompare(right.title, 'ru');
}

function buildPanoramaUnits(dataset, tableData) {
  const metaLookup = buildGroupMetaLookup(dataset, tableData);
  const familyUnits = buildChildFamilyUnits(dataset, tableData, metaLookup);
  const occupiedFamilyKeys = new Set(familyUnits.map((unit) => familyKey(unit.parentIds)));
  const coupleUnits = buildCoupleUnits(dataset, tableData, occupiedFamilyKeys);
  const coveredPeopleIds = new Set();

  for (const unit of [...familyUnits, ...coupleUnits]) {
    [...unit.topRowIds, ...unit.childIds].forEach((personId) => coveredPeopleIds.add(personId));
  }

  const singleUnits = buildSingleUnits(dataset, tableData, coveredPeopleIds);

  return [...familyUnits, ...coupleUnits, ...singleUnits]
    .sort((left, right) => compareUnits(left, right, tableData))
    .map((unit, index) => ({
      ...unit,
      sortIndex: index,
    }));
}

function computeBaseLaneCenters(units) {
  const measured = units.map((unit) => ({
    unit,
    width: measureUnit(unit).width,
  }));
  const totalWidth = measured.reduce((sum, item) => sum + item.width, 0)
    + Math.max(0, measured.length - 1) * PANORAMA_LAYOUT.familyGapX;
  let cursorLeft = -totalWidth / 2;

  return new Map(measured.map((item) => {
    const center = cursorLeft + (item.width / 2);
    cursorLeft += item.width + PANORAMA_LAYOUT.familyGapX;
    return [item.unit.id, center];
  }));
}

function computeUnitAnchorX(unit, previousLanePositions, fallbackCenter) {
  const anchorIds = unit.topRowIds?.length
    ? unit.topRowIds
    : unit.personIds?.length
      ? unit.personIds
      : unit.childIds || [];
  const knownPositions = anchorIds
    .map((personId) => previousLanePositions.get(personId))
    .filter((value) => Number.isFinite(value));

  if (knownPositions.length > 0) {
    return average(knownPositions);
  }

  return fallbackCenter;
}

function computeLanePlacements(units, previousLanePositions) {
  const baseCenters = computeBaseLaneCenters(units);
  const entries = units.map((unit) => ({
    unit,
    width: measureUnit(unit).width,
    desiredCenter: computeUnitAnchorX(unit, previousLanePositions, baseCenters.get(unit.id) ?? 0),
    baseCenter: baseCenters.get(unit.id) ?? 0,
  }));

  entries.sort((left, right) => {
    if (left.desiredCenter !== right.desiredCenter) {
      return left.desiredCenter - right.desiredCenter;
    }

    return (left.unit.sortIndex ?? 0) - (right.unit.sortIndex ?? 0);
  });

  let previousRight = null;
  for (const entry of entries) {
    const halfWidth = entry.width / 2;
    let center = entry.desiredCenter;

    if (previousRight != null) {
      center = Math.max(center, previousRight + PANORAMA_LAYOUT.familyGapX + halfWidth);
    }

    entry.centerX = center;
    previousRight = center + halfWidth;
  }

  const averageDesired = average(entries.map((entry) => entry.desiredCenter));
  const averageActual = average(entries.map((entry) => entry.centerX));
  const shift = averageDesired - averageActual;
  const placements = new Map();

  for (const entry of entries) {
    placements.set(entry.unit.id, entry.centerX + shift);
  }

  return placements;
}

function buildCardNode(dataset, unit, personId, x, y, role, occurrenceIndex) {
  const person = dataset.people.get(personId);
  const fullName = personName(dataset, personId);
  const subtitle = getLifeYears(person);
  const textLayout = fitPanoramaCardText(fullName, subtitle);

  return {
    id: `${unit.id}:${role}:${occurrenceIndex}:${personId}`,
    personId,
    unitId: unit.id,
    role,
    fullName,
    subtitle,
    title: `${fullName}${subtitle ? `\n${subtitle}` : ''}`,
    nameLines: textLayout.nameLines,
    fontSize: textLayout.fontSize,
    subtitleFontSize: textLayout.subtitleFontSize,
    background: unit.softColor,
    headerColor: unit.headerColor,
    borderColor: unit.color,
    familyColor: unit.color,
    x,
    y,
    focusX: x,
    focusY: y,
    width: PANORAMA_LAYOUT.cardWidth,
    height: PANORAMA_LAYOUT.cardHeight,
    minX: x - (PANORAMA_LAYOUT.cardWidth / 2),
    maxX: x + (PANORAMA_LAYOUT.cardWidth / 2),
    minY: y - (PANORAMA_LAYOUT.cardHeight / 2),
    maxY: y + (PANORAMA_LAYOUT.cardHeight / 2),
  };
}

function layoutUnit(dataset, unit, topY, centerX) {
  const measure = measureUnit(unit);
  const boxLeft = centerX - (measure.width / 2);
  const boxTop = topY;
  const titleFontSize = fitPanoramaHeaderText(unit.title, measure.width);
  const titleY = boxTop + 18;
  const metaFontSize = 11;
  const nodes = [];
  const links = [];
  const occurrences = [];

  const parentXs = rowCardCenters(centerX, unit.topRowIds.length);
  const parentNodes = unit.topRowIds.map((personId, index) => {
    const node = buildCardNode(dataset, unit, personId, parentXs[index], measure.parentsY + boxTop, 'parent', index);
    nodes.push(node);
    occurrences.push(node);
    return node;
  });

  const childRowNodes = unit.childRows.map((row, rowIndex) => {
    const rowXs = rowCardCenters(centerX, row.length);
    const childY = boxTop + measure.childRowCenters[rowIndex];

    return row.map((personId, index) => {
      const node = buildCardNode(dataset, unit, personId, rowXs[index], childY, 'child', rowIndex * 10 + index);
      nodes.push(node);
      occurrences.push(node);
      return node;
    });
  });

  if (parentNodes.length === 2) {
    const left = parentNodes[0].x <= parentNodes[1].x ? parentNodes[0] : parentNodes[1];
    const right = left === parentNodes[0] ? parentNodes[1] : parentNodes[0];
    const coupleY = average([left.y, right.y]);
    links.push(makeLineLink(
      `couple:${unit.id}`,
      'panorama-link-couple',
      left.x + (left.width / 2),
      coupleY,
      right.x - (right.width / 2),
      coupleY
    ));
  }

  if (childRowNodes.length > 0) {
    const trunkX = average(parentNodes.map((node) => node.x));
    const trunkStartY = parentNodes.length === 2
      ? average(parentNodes.map((node) => node.y))
      : average(parentNodes.map((node) => node.y + (node.height / 2)));
    const lastRowNodes = childRowNodes.at(-1) || [];
    const lastBusY = average(lastRowNodes.map((node) => node.y - (node.height / 2) - PANORAMA_LAYOUT.childBusGapY));

    links.push(makeLineLink(
      `trunk:${unit.id}`,
      'panorama-link-trunk',
      trunkX,
      trunkStartY,
      trunkX,
      lastBusY
    ));

    childRowNodes.forEach((rowNodes, rowIndex) => {
      const busY = rowNodes[0].y - (rowNodes[0].height / 2) - PANORAMA_LAYOUT.childBusGapY;
      const minBusX = Math.min(trunkX, ...rowNodes.map((node) => node.x));
      const maxBusX = Math.max(trunkX, ...rowNodes.map((node) => node.x));

      if (maxBusX > minBusX) {
        links.push(makeLineLink(
          `bus:${unit.id}:${rowIndex}`,
          'panorama-link-bus',
          minBusX,
          busY,
          maxBusX,
          busY
        ));
      }

      rowNodes.forEach((node) => {
        links.push(makeLineLink(
          `child:${unit.id}:${node.id}`,
          'panorama-link-child',
          node.x,
          busY,
          node.x,
          node.y - (node.height / 2)
        ));
      });
    });
  }

  const personIds = Array.from(new Set(occurrences.map((node) => node.personId)));
  const familyBox = {
    id: `box:${unit.id}`,
    unitId: unit.id,
    title: unit.title,
    meta: formatFamilyMeta(unit),
    color: unit.color,
    softColor: unit.softColor,
    headerColor: unit.headerColor,
    x: boxLeft,
    y: boxTop,
    width: measure.width,
    height: measure.height,
    titleX: centerX,
    titleY,
    titleFontSize,
    metaX: centerX,
    metaY: boxTop + 34,
    metaFontSize,
    minX: boxLeft,
    maxX: boxLeft + measure.width,
    minY: boxTop,
    maxY: boxTop + measure.height,
    personIds,
  };

  return {
    nodes,
    links,
    familyBox,
    height: measure.height,
  };
}

function buildContinuationLinks(nodesByPerson) {
  const links = [];

  for (const [personId, nodes] of nodesByPerson.entries()) {
    const sortedNodes = nodes
      .slice()
      .sort((left, right) => left.y - right.y);

    for (let index = 0; index < sortedNodes.length - 1; index += 1) {
      const fromNode = sortedNodes[index];
      const toNode = sortedNodes[index + 1];
      if (Math.abs(toNode.y - fromNode.y) < 32) continue;

      links.push(makeCurveLink(
        `continuation:${personId}:${index}`,
        'panorama-link-continuation',
        fromNode.x,
        fromNode.y + (fromNode.height / 2),
        toNode.x,
        toNode.y - (toNode.height / 2)
      ));
    }
  }

  return links;
}

export function buildPanoramaGraph(dataset, rootId) {
  const tableData = buildPeopleTableData(dataset, { anchorId: rootId });
  const units = buildPanoramaUnits(dataset, tableData);
  const lanesByKey = new Map();

  for (const unit of units) {
    const key = generationKey(unit.generationId);
    if (!lanesByKey.has(key)) {
      lanesByKey.set(key, {
        key,
        generationId: unit.generationId,
        units: [],
      });
    }

    lanesByKey.get(key).units.push(unit);
  }

  const lanes = Array.from(lanesByKey.values())
    .sort((left, right) => {
      const leftValue = left.generationId ?? Number.MAX_SAFE_INTEGER;
      const rightValue = right.generationId ?? Number.MAX_SAFE_INTEGER;
      return leftValue - rightValue;
    });

  const nodes = [];
  const familyBoxes = [];
  const familyLinks = [];
  const generationBands = [];
  const primaryNodeByPersonId = new Map();
  const nodesByPerson = new Map();
  let previousLanePositions = new Map();
  let laneTopY = 0;

  for (const lane of lanes) {
    const laneLayouts = [];
    let laneHeight = 0;

    for (const unit of lane.units) {
      const measure = measureUnit(unit);
      laneLayouts.push({
        unit,
        width: measure.width,
      });
      laneHeight = Math.max(laneHeight, measure.height);
    }

    const lanePlacements = computeLanePlacements(lane.units, previousLanePositions);
    let laneMinX = Number.POSITIVE_INFINITY;
    let laneMaxX = Number.NEGATIVE_INFINITY;
    const currentLanePositionBuckets = new Map();

    for (const item of laneLayouts) {
      const centerX = lanePlacements.get(item.unit.id) ?? 0;
      const layout = layoutUnit(dataset, item.unit, laneTopY, centerX);

      familyBoxes.push(layout.familyBox);
      familyLinks.push(...layout.links);
      nodes.push(...layout.nodes);

      laneMinX = Math.min(laneMinX, layout.familyBox.minX);
      laneMaxX = Math.max(laneMaxX, layout.familyBox.maxX);

      for (const node of layout.nodes) {
        if (!nodesByPerson.has(node.personId)) {
          nodesByPerson.set(node.personId, []);
        }
        nodesByPerson.get(node.personId).push(node);

        const currentPrimary = primaryNodeByPersonId.get(node.personId);
        const currentPriority = currentPrimary?.role === 'child' ? 2 : 1;
        const nextPriority = node.role === 'child' ? 2 : 1;
        if (!currentPrimary || nextPriority < currentPriority) {
          primaryNodeByPersonId.set(node.personId, node);
        }

        if (!currentLanePositionBuckets.has(node.personId)) {
          currentLanePositionBuckets.set(node.personId, []);
        }
        currentLanePositionBuckets.get(node.personId).push(node.x);
      }
    }

    generationBands.push({
      id: `generation:${lane.key}`,
      label: generationLabel(lane.generationId),
      x: laneMinX - PANORAMA_LAYOUT.generationBandPaddingX,
      y: laneTopY - PANORAMA_LAYOUT.generationBandInsetY,
      width: (laneMaxX - laneMinX) + (PANORAMA_LAYOUT.generationBandPaddingX * 2),
      height: laneHeight + (PANORAMA_LAYOUT.generationBandInsetY * 2),
      labelX: laneMinX - PANORAMA_LAYOUT.generationBandPaddingX + PANORAMA_LAYOUT.generationLabelInsetX,
      labelY: laneTopY + 26,
      minX: laneMinX - PANORAMA_LAYOUT.generationBandPaddingX,
      maxX: laneMaxX + PANORAMA_LAYOUT.generationBandPaddingX,
      minY: laneTopY - PANORAMA_LAYOUT.generationBandInsetY,
      maxY: laneTopY + laneHeight + PANORAMA_LAYOUT.generationBandInsetY,
    });

    previousLanePositions = new Map(
      Array.from(currentLanePositionBuckets.entries()).map(([personId, positions]) => [
        personId,
        average(positions),
      ])
    );
    laneTopY += laneHeight + PANORAMA_LAYOUT.laneGapY;
  }

  const continuationLinks = buildContinuationLinks(nodesByPerson);

  return {
    visualization: 'panorama',
    mode: 'panorama',
    focusNodeId: rootId,
    rootNodeId: rootId,
    nodes,
    familyBoxes,
    links: familyLinks,
    continuationLinks,
    generationBands,
    primaryNodeByPersonId: new Map(
      Array.from(primaryNodeByPersonId.entries()).map(([personId, node]) => [personId, node.id])
    ),
    bounds: computeBounds(nodes, [...familyBoxes, ...familyLinks, ...continuationLinks, ...generationBands]),
  };
}

export class D3PanoramaNetwork extends BaseD3Network {
  constructor(container, graphData, handlers = {}) {
    super(container, graphData, handlers);

    const nodeById = new Map(graphData.nodes.map((node) => [node.id, node]));
    const personNodeMap = new Map();

    for (const [personId, nodeId] of graphData.primaryNodeByPersonId.entries()) {
      const node = nodeById.get(nodeId);
      if (node) {
        personNodeMap.set(personId, node);
      }
    }

    this.nodeMap = personNodeMap;
    this.body.data.nodes.get = (id) => this.nodeMap.get(id) || null;
  }

  draw() {
    const d3 = getD3();

    this.bandLayer = this.viewport.append('g').attr('class', 'panorama-band-layer');
    this.continuationLayer = this.viewport.append('g').attr('class', 'panorama-continuation-layer');
    this.boxLayer = this.viewport.append('g').attr('class', 'panorama-box-layer');
    this.linkLayer = this.viewport.append('g').attr('class', 'panorama-link-layer');
    this.nodeLayer = this.viewport.append('g').attr('class', 'panorama-node-layer');

    this.bandLayer
      .selectAll('g')
      .data(this.graphData.generationBands, (band) => band.id)
      .join((enter) => {
        const group = enter.append('g').attr('class', 'panorama-band');
        group.append('rect').attr('class', 'panorama-band-shape');
        group.append('text').attr('class', 'panorama-band-label');
        return group;
      })
      .each(function renderBand(band) {
        const group = d3.select(this);
        group.select('.panorama-band-shape')
          .attr('x', band.x)
          .attr('y', band.y)
          .attr('width', band.width)
          .attr('height', band.height)
          .attr('rx', 26)
          .attr('ry', 26);

        group.select('.panorama-band-label')
          .attr('x', band.labelX)
          .attr('y', band.labelY)
          .text(band.label);
      });

    this.continuationLayer
      .selectAll('path')
      .data(this.graphData.continuationLinks, (link) => link.id)
      .join('path')
      .attr('class', (link) => link.className)
      .attr('d', (link) => link.d);

    this.familyBoxSelection = this.boxLayer
      .selectAll('g')
      .data(this.graphData.familyBoxes, (box) => box.id)
      .join((enter) => {
        const group = enter.append('g').attr('class', 'panorama-family');
        group.append('rect').attr('class', 'panorama-family-box');
        group.append('rect').attr('class', 'panorama-family-header');
        group.append('text').attr('class', 'panorama-family-title');
        group.append('text').attr('class', 'panorama-family-meta');
        return group;
      })
      .each(function renderBox(box) {
        const group = d3.select(this);
        group.select('.panorama-family-box')
          .attr('x', box.x)
          .attr('y', box.y)
          .attr('width', box.width)
          .attr('height', box.height)
          .attr('rx', 20)
          .attr('ry', 20)
          .attr('fill', box.softColor)
          .attr('stroke', box.color);

        group.select('.panorama-family-header')
          .attr('x', box.x)
          .attr('y', box.y)
          .attr('width', box.width)
          .attr('height', PANORAMA_LAYOUT.boxHeaderHeight)
          .attr('rx', 20)
          .attr('ry', 20)
          .attr('fill', box.headerColor);

        group.select('.panorama-family-title')
          .attr('x', box.titleX)
          .attr('y', box.titleY)
          .style('font-size', `${box.titleFontSize}px`)
          .text(box.title);

        group.select('.panorama-family-meta')
          .attr('x', box.metaX)
          .attr('y', box.metaY)
          .style('font-size', `${box.metaFontSize}px`)
          .text(box.meta);
      });

    for (const link of this.graphData.links) {
      if (link.shape === 'path') {
        this.linkLayer.append('path')
          .attr('class', link.className)
          .attr('d', link.d);
        continue;
      }

      this.linkLayer.append('line')
        .attr('class', link.className)
        .attr('x1', link.x1)
        .attr('y1', link.y1)
        .attr('x2', link.x2)
        .attr('y2', link.y2);
    }

    this.nodeSelection = this.nodeLayer
      .selectAll('foreignObject')
      .data(this.graphData.nodes, (node) => node.id)
      .join('foreignObject')
      .attr('class', 'panorama-node')
      .attr('x', (node) => node.x - (node.width / 2))
      .attr('y', (node) => node.y - (node.height / 2))
      .attr('width', (node) => node.width)
      .attr('height', (node) => node.height)
      .style('overflow', 'visible')
      .on('click', (event, node) => {
        event.stopPropagation();
        this.handlers.onSelect?.(node.personId);
      });

    this.nodeSelection.each(function renderNode(node) {
      const foreignObject = d3.select(this);
      const content = foreignObject.append('xhtml:div')
        .attr('class', `panorama-card${node.role === 'parent' ? ' is-parent' : ' is-child'}`)
        .style('background', node.background)
        .style('border-color', node.borderColor)
        .style('--family-color', node.familyColor)
        .style('--family-header', node.headerColor)
        .style('font-size', `${node.fontSize}px`)
        .attr('title', node.title);

      const body = content.append('xhtml:div').attr('class', 'panorama-card-body');
      const name = body.append('xhtml:div').attr('class', 'panorama-card-name');

      for (const line of node.nameLines) {
        name.append('xhtml:div').text(line);
      }

      if (node.subtitle) {
        body.append('xhtml:div')
          .attr('class', 'panorama-card-years')
          .style('font-size', `${node.subtitleFontSize}px`)
          .text(node.subtitle);
      }
    });
  }

  updateSelection() {
    this.nodeSelection
      .select('.panorama-card')
      .classed('is-selected', (node) => this.selectedNodeIds.has(node.personId));

    this.familyBoxSelection
      .classed('is-selected', (box) => box.personIds.some((personId) => this.selectedNodeIds.has(personId)));
  }
}
