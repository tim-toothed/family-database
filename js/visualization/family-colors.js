const BRANCH_BASE_PALETTE = [
  { h: 198, s: 78, l: 58 },
  { h: 186, s: 74, l: 55 },
  { h: 170, s: 66, l: 52 },
  { h: 154, s: 60, l: 52 },
  { h: 134, s: 62, l: 54 },
  { h: 46, s: 90, l: 64 },
  { h: 30, s: 88, l: 65 },
  { h: 14, s: 82, l: 66 },
  { h: 356, s: 78, l: 67 },
  { h: 338, s: 68, l: 66 },
  { h: 286, s: 62, l: 66 },
  { h: 248, s: 60, l: 67 },
];

const BRANCH_CYCLE_OFFSETS = [
  { h: 0, s: 0, l: 0 },
  { h: 10, s: -2, l: 2 },
  { h: -12, s: 4, l: -1 },
  { h: 18, s: -3, l: 4 },
];

const VARIANT_STEPS = [
  { h: -5, s: 4, l: -5 },
  { h: -2, s: -2, l: -1 },
  { h: 0, s: 0, l: 0 },
  { h: 3, s: 2, l: 4 },
  { h: 5, s: -4, l: 7 },
  { h: -3, s: 1, l: 6 },
];

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function hashString(value) {
  let hash = 0;
  const text = String(value || '');

  for (let index = 0; index < text.length; index += 1) {
    hash = ((hash << 5) - hash) + text.charCodeAt(index);
    hash |= 0;
  }

  return Math.abs(hash);
}

function normalizeHue(value) {
  const hue = value % 360;
  return hue < 0 ? hue + 360 : hue;
}

function hslToHex(h, s, l) {
  const hue = normalizeHue(h);
  const saturation = clamp(s, 0, 100) / 100;
  const lightness = clamp(l, 0, 100) / 100;
  const chroma = (1 - Math.abs((2 * lightness) - 1)) * saturation;
  const segment = hue / 60;
  const second = chroma * (1 - Math.abs((segment % 2) - 1));
  const match = lightness - (chroma / 2);

  let red = 0;
  let green = 0;
  let blue = 0;

  if (segment >= 0 && segment < 1) {
    red = chroma;
    green = second;
  } else if (segment < 2) {
    red = second;
    green = chroma;
  } else if (segment < 3) {
    green = chroma;
    blue = second;
  } else if (segment < 4) {
    green = second;
    blue = chroma;
  } else if (segment < 5) {
    red = second;
    blue = chroma;
  } else {
    red = chroma;
    blue = second;
  }

  const toHex = (value) => (
    Math.round((value + match) * 255)
      .toString(16)
      .padStart(2, '0')
  );

  return `#${toHex(red)}${toHex(green)}${toHex(blue)}`;
}

function buildTint(tone, { saturationScale, saturationShift = 0, lightness }) {
  return hslToHex(
    tone.h,
    clamp((tone.s * saturationScale) + saturationShift, 22, 68),
    clamp(lightness, 78, 94)
  );
}

function branchSeedFromId(branchId) {
  const numeric = Number(branchId);
  if (Number.isFinite(numeric) && numeric > 0) {
    return Math.abs(Math.trunc(numeric) - 1);
  }

  return hashString(branchId);
}

function buildBranchBase(branchId) {
  const seed = branchSeedFromId(branchId);
  const base = BRANCH_BASE_PALETTE[seed % BRANCH_BASE_PALETTE.length];
  const cycle = Math.floor(seed / BRANCH_BASE_PALETTE.length);
  const offset = BRANCH_CYCLE_OFFSETS[cycle % BRANCH_CYCLE_OFFSETS.length];

  return {
    h: normalizeHue(base.h + offset.h),
    s: clamp(base.s + offset.s, 52, 92),
    l: clamp(base.l + offset.l, 52, 74),
  };
}

function normalizeSex(value) {
  return String(value ?? '').trim().toLowerCase();
}

export function pickBranchPersonId(dataset, personIds = []) {
  const ids = Array.from(new Set(personIds)).filter(Boolean);

  const maleId = ids.find((personId) => normalizeSex(dataset?.people?.get(personId)?.sex) === '\u043c');
  if (maleId) return maleId;

  const femaleId = ids.find((personId) => normalizeSex(dataset?.people?.get(personId)?.sex) === '\u0436');
  if (femaleId) return femaleId;

  return ids[0] || null;
}

export function buildFamilyColorTheme(dataset, tableData, options = {}) {
  if (options.neutral) {
    return {
      branchId: null,
      branchColor: '#94a3b8',
      color: '#94a3b8',
      softColor: '#f1f5f9',
      headerColor: '#e2e8f0',
    };
  }

  const branchPersonId = options.branchPersonId
    || pickBranchPersonId(dataset, options.personIds || []);
  const branchId = tableData?.familyIdByPerson?.get(branchPersonId)
    ?? options.branchId
    ?? branchPersonId
    ?? 'default';
  const base = buildBranchBase(branchId);
  const variant = VARIANT_STEPS[hashString(options.variantKey || branchId) % VARIANT_STEPS.length];
  const tone = {
    h: base.h + variant.h,
    s: clamp(base.s + variant.s, 52, 90),
    l: clamp(base.l + variant.l, 52, 72),
  };
  const color = hslToHex(tone.h, tone.s, tone.l);
  const branchColor = hslToHex(base.h, base.s, base.l);

  return {
    branchId,
    branchColor,
    color,
    softColor: buildTint(tone, { saturationScale: 0.42, saturationShift: 14, lightness: 90 }),
    headerColor: buildTint(tone, { saturationScale: 0.62, saturationShift: 16, lightness: 82 }),
  };
}
