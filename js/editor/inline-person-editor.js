import { createEditablePerson, loadEditablePerson, saveEditablePerson } from '../db/editor-store.js';
import { getPersonFieldLabel, PERSON_SECTION_ORDER } from '../person/labels.js';
import { getDatasetPersonName, personHasField } from '../person/model.js';
import {
  buildChildRelationTypeFromParent,
  buildParentRelationTypeFromChild,
  computeNextPersonId as computeNextPersonIdFromIds,
  resolvePersonLookupTarget as resolvePersonLookupTargetFromUtils,
} from '../utils/person-utils.js';
import { clonePlainValue, escapeHtml } from '../utils/normalize.js';
import {
  addDraftArrayItem,
  addOtherInfoEntry,
  createDraftFromSchema,
  hydrateDraftForEditor,
  removeDraftArrayItem,
  removeOtherInfoEntry,
  renderEditablePersonDetails,
  renderEditablePersonSection,
  setAliveState,
  setDivorcedState,
  syncNameChangeDateField,
  updateDraftValue,
  validateEditorPersonDraft,
} from './person-editor.js';
import {
  buildPersonOptionEntries,
  getValueByEditorPath,
  initializeLinkMaskedFields,
  parseEditorPath,
} from './utils.js';

function renderInlineStatus({ message, tone, activeSectionKey }) {
  if (!message) return '';
  if (activeSectionKey && tone === 'error') return '';
  return `
    <div class="details-inline-status is-${escapeHtml(tone)}">
      ${escapeHtml(message)}
    </div>
  `;
}

function renderReadOnlySection(section, options = {}) {
  const isBusy = options.disabled ? ' disabled' : '';
  const isLoading = options.isLoading;

  return `
    <section class="field-block person-card-section${isLoading ? ' is-loading' : ''}" data-section-key="${escapeHtml(section.key)}">
      <button
        type="button"
        class="card-section-edit-button"
        data-action="edit-section"
        data-section-key="${escapeHtml(section.key)}"
        aria-label="Редактировать секцию ${escapeHtml(section.label)}"
        title="Редактировать секцию"
        ${isBusy}
      >✎</button>
      <h3 class="field-title">${escapeHtml(section.label)}</h3>
      <div class="field-value">${section.html}</div>
      ${isLoading ? '<div class="card-section-loading">Загрузка редактора...</div>' : ''}
    </section>
  `;
}

function renderLoadingSection(sectionKey, options = {}) {
  return renderReadOnlySection({
    key: sectionKey,
    label: getPersonFieldLabel(sectionKey, { context: 'editor' }),
    html: '<div class="card-section-loading-copy">Подготавливаю форму редактирования…</div>',
  }, {
    disabled: options.disabled,
    isLoading: true,
  });
}

function renderEditableSectionCard(sectionKey, state) {
  const {
    draft,
    schema,
    descriptions,
    personOptionEntries,
    savingSectionKey,
    statusMessage,
    statusTone,
    sectionIsDirty,
  } = state;
  if (!draft || !schema) return '';

  const section = renderEditablePersonSection(sectionKey, draft, schema, descriptions, {
    personOptionEntries,
    enumListIdPrefix: 'inlineEditorEnum',
    enableRelationPicker: true,
  });
  if (!section) return '';

  const isSaving = savingSectionKey === sectionKey;
  const hasInlineError = statusTone === 'error' && Boolean(statusMessage);
  const dirtyLabel = hasInlineError
    ? statusMessage
    : sectionIsDirty
      ? 'Есть несохранённые изменения'
      : 'Без несохранённых изменений';

  return `
    <section
      class="field-block is-editing person-card-section person-card-section-editing${section.isDisabled ? ' is-disabled' : ''}${section.isCollapsed ? ' is-collapsed' : ''}"
      data-section-key="${escapeHtml(sectionKey)}"
    >
      <div class="editor-section-head">
        <h3 class="field-title">${escapeHtml(section.label)}</h3>
        ${section.headerControlHtml}
      </div>
      ${section.description ? `<p class="editor-section-note">${escapeHtml(section.description)}</p>` : ''}
      ${section.isCollapsed ? '' : `
        <div class="field-value">
          ${section.bodyHtml}
        </div>
      `}
      <div class="card-section-actions">
        <div class="card-section-action-row">
          <button type="button" class="card-section-action card-section-action-primary" data-action="save-inline-section" ${isSaving ? 'disabled' : ''}>${isSaving ? 'Сохранение...' : 'Сохранить'}</button>
          <button type="button" class="card-section-action" data-action="cancel-inline-section" ${isSaving ? 'disabled' : ''}>Отмена</button>
          <button type="button" class="card-section-action card-section-action-danger" data-action="delete-inline-section" ${isSaving ? 'disabled' : ''}>Удалить всю секцию</button>
        </div>
        <div class="card-section-dirty${sectionIsDirty ? ' is-dirty' : ''}${hasInlineError ? ' is-error' : ''}">
          ${escapeHtml(dirtyLabel)}
        </div>
      </div>
    </section>
  `;
}

function renderAddSectionControls(savedPerson, state) {
  const isBusy = Boolean(state.loadingSectionKey || state.savingSectionKey);
  const addableSectionKeys = PERSON_SECTION_ORDER.filter((key) => (
    !personHasField(savedPerson, key)
    && key !== state.activeSectionKey
    && key !== state.loadingSectionKey
  ));

  if (!addableSectionKeys.length) {
    return '';
  }

  if (isBusy) {
    return '<button type="button" class="card-add-section-trigger" disabled>Добавить секцию</button>';
  }

  return `
    <details class="card-add-section-menu">
      <summary class="card-add-section-trigger">Добавить секцию</summary>
      <div class="card-add-section-list">
        ${addableSectionKeys.map((key) => `
          <button type="button" class="card-add-section-option" data-action="add-section" data-section-key="${escapeHtml(key)}">
            ${escapeHtml(getPersonFieldLabel(key, { context: 'editor' }))}
          </button>
        `).join('')}
      </div>
    </details>
  `;
}

function renderDeletePersonControl(personId, state) {
  if (!personId || state.isVirtualNode(personId)) return '';
  const disabled = state.loadingSectionKey || state.savingSectionKey ? ' disabled' : '';
  return `
    <button type="button" class="delete-person-button" data-action="delete-person" ${disabled}>
      Удалить карточку
    </button>
  `;
}

function renderInlinePersonCard({ personId, person, detailsView, state }) {
  const sectionByKey = new Map(detailsView.sections.map((section) => [section.key, section]));
  const sectionKeys = PERSON_SECTION_ORDER.filter((key) => (
    sectionByKey.has(key)
    || key === state.activeSectionKey
    || key === state.loadingSectionKey
  ));
  const disableSectionButtons = Boolean(state.loadingSectionKey || state.savingSectionKey);

  const sectionsHtml = sectionKeys.map((key) => {
    if (key === state.activeSectionKey) {
      return renderEditableSectionCard(key, state);
    }
    if (key === state.loadingSectionKey) {
      return renderLoadingSection(key, { disabled: disableSectionButtons });
    }

    const section = sectionByKey.get(key);
    if (!section) return '';
    return renderReadOnlySection(section, { disabled: disableSectionButtons });
  }).join('');

  return `
    <div class="person-card-sections">
      ${sectionsHtml}
    </div>
    ${renderInlineStatus({
      message: state.statusMessage,
      tone: state.statusTone,
      activeSectionKey: state.activeSectionKey,
    })}
    ${renderAddSectionControls(person, state)}
    ${renderDeletePersonControl(personId, state)}
  `;
}

export function createInlinePersonEditorController(options) {
  const {
    elements,
    getDataset,
    getSchema,
    getDescriptions,
    getSelectedPersonId,
    setSelectedPersonId,
    getDbLabel,
    buildPersonDetailsView,
    bindPersonLinks,
    isVirtualNode,
    onLinkedPersonSelected,
    onLookupsChanged,
    onReloadDatasetAfterSave,
    onDeletePersonRequested,
  } = options;

  const personBody = elements.personBody;
  const personTitle = elements.personTitle;
  const personSubtitle = elements.personSubtitle;
  const newRelationPersonDialog = elements.newRelationPersonDialog;
  const newRelationPersonSurnameInput = elements.newRelationPersonSurnameInput;
  const newRelationPersonFirstNameInput = elements.newRelationPersonFirstNameInput;
  const newRelationPersonPatronymicInput = elements.newRelationPersonPatronymicInput;
  const newRelationPersonMessage = elements.newRelationPersonMessage;
  const newRelationPersonCreateButton = elements.newRelationPersonCreateButton;

  let inlineDraft = null;
  let activeInlineSectionKey = '';
  let inlineOriginalSectionSnapshot = '';
  let inlineStatusMessage = '';
  let inlineStatusTone = 'info';
  let inlineLoadingSectionKey = '';
  let inlineSavingSectionKey = '';
  let inlineEditRequestToken = 0;
  let pendingNewPeople = new Map();
  let activeRelationCreateInput = null;
  let personOptionEntries = [];
  let optionValueToId = new Map();

  function getCurrentPersonId() {
    return getSelectedPersonId();
  }

  function getCurrentDataset() {
    return getDataset();
  }

  function getCurrentSchema() {
    return getSchema();
  }

  function getCurrentDescriptions() {
    return getDescriptions();
  }

  function resolvePersonLookupTarget(rawValue) {
    return resolvePersonLookupTargetFromUtils(rawValue, {
      peopleById: getCurrentDataset()?.indexById,
      optionValueToId,
    });
  }

  function formatPersonLookupValue(personId) {
    if (!personId) return '';
    const dataset = getCurrentDataset();
    const entry = personOptionEntries.find((item) => item.id === personId);
    return entry?.label || getDatasetPersonName(dataset, personId, personId);
  }

  function getFilteredPersonOptions(rawValue, limit = 10) {
    const query = String(rawValue || '').trim().toLocaleLowerCase('ru');
    const entries = query
      ? personOptionEntries.filter((entry) => {
        const label = entry.label.toLocaleLowerCase('ru');
        const id = entry.id.toLocaleLowerCase('ru');
        return label.includes(query) || id.includes(query);
      })
      : personOptionEntries;

    return entries.slice(0, limit);
  }

  function computeNextPersonId(extraIds = []) {
    const ids = [
      ...Array.from(getCurrentDataset()?.indexById?.keys?.() || []),
      ...Array.from(pendingNewPeople.keys()),
    ];
    return computeNextPersonIdFromIds(ids, extraIds);
  }

  function buildMirroredSpouseEntry(personId, spouseEntry) {
    const entry = { person_id: personId };
    if (Array.isArray(spouseEntry?.marriage) && spouseEntry.marriage.length) {
      entry.marriage = clonePlainValue(spouseEntry.marriage);
    }
    if (Array.isArray(spouseEntry?.divorce) && spouseEntry.divorce.length) {
      entry.divorce = clonePlainValue(spouseEntry.divorce);
    }
    return entry;
  }

  function getNewRelationNameParts() {
    return {
      surname: String(newRelationPersonSurnameInput?.value || '').trim(),
      first_name: String(newRelationPersonFirstNameInput?.value || '').trim(),
      patronymic: String(newRelationPersonPatronymicInput?.value || '').trim(),
    };
  }

  function formatNameParts(parts) {
    return [parts.surname, parts.first_name, parts.patronymic].filter(Boolean).join(' ');
  }

  function getCurrentRelationItem(input) {
    const path = parseEditorPath(input?.dataset?.path || '');
    if (!path.length) return {};
    return getValueByEditorPath(inlineDraft, path.slice(0, -1)) || {};
  }

  function applyReciprocalRelationToPendingPayload(payload, input) {
    const selectedPersonId = getCurrentPersonId();
    if (!selectedPersonId || !activeInlineSectionKey) return;

    const sourcePerson = inlineDraft || getCurrentDataset()?.people?.get(selectedPersonId) || {};
    const relationItem = getCurrentRelationItem(input);

    if (activeInlineSectionKey === 'parents') {
      const entry = { person_id: selectedPersonId };
      const relationType = buildChildRelationTypeFromParent(relationItem.relation_type);
      if (relationType) entry.relation_type = relationType;
      payload.children = [entry];
      return;
    }

    if (activeInlineSectionKey === 'children') {
      const entry = { person_id: selectedPersonId };
      const relationType = buildParentRelationTypeFromChild(relationItem.relation_type, sourcePerson.sex);
      if (relationType) entry.relation_type = relationType;
      payload.parents = [entry];
      return;
    }

    if (activeInlineSectionKey === 'siblings') {
      const entry = { person_id: selectedPersonId };
      if (relationItem.relation_type) entry.relation_type = relationItem.relation_type;
      payload.siblings = [entry];
      return;
    }

    if (activeInlineSectionKey === 'spouses') {
      payload.spouses = [buildMirroredSpouseEntry(selectedPersonId, relationItem)];
    }
  }

  function createPendingPersonPayload(personId, nameParts, input) {
    const payload = {
      id: personId,
      birth_name: {
        surname: nameParts.surname,
        first_name: nameParts.first_name,
        patronymic: nameParts.patronymic,
      },
    };
    applyReciprocalRelationToPendingPayload(payload, input);
    return payload;
  }

  function getPeopleIndexWithPending() {
    const peopleById = new Map(getCurrentDataset()?.indexById || []);
    for (const [personId, item] of pendingNewPeople.entries()) {
      peopleById.set(personId, item.displayName);
    }
    return peopleById;
  }

  function refreshLookups() {
    const dataset = getCurrentDataset();
    if (!dataset) return;

    const { entries, optionValueToId: lookup } = buildPersonOptionEntries(dataset);
    personOptionEntries = entries;
    optionValueToId = lookup;
    onLookupsChanged?.(entries);
  }

  function reset(options = {}) {
    activeInlineSectionKey = '';
    inlineDraft = null;
    inlineOriginalSectionSnapshot = '';
    inlineLoadingSectionKey = '';
    inlineSavingSectionKey = '';
    inlineEditRequestToken += 1;
    pendingNewPeople.clear();
    activeRelationCreateInput = null;

    if (getCurrentDataset()) {
      refreshLookups();
    }

    if (options.clearStatus !== false) {
      inlineStatusMessage = '';
      inlineStatusTone = 'info';
    }
  }

  function serializeSectionSnapshot(sectionKey, personDraft = inlineDraft) {
    const hasOwnSection = Boolean(
      sectionKey
      && personDraft
      && Object.prototype.hasOwnProperty.call(personDraft, sectionKey)
    );

    return JSON.stringify(
      hasOwnSection
        ? { hasSection: true, value: personDraft[sectionKey] }
        : { hasSection: false }
    );
  }

  function hasUnsavedChanges() {
    if (!activeInlineSectionKey || !inlineDraft) return false;
    return serializeSectionSnapshot(activeInlineSectionKey) !== inlineOriginalSectionSnapshot;
  }

  function canDiscardChanges() {
    if (!hasUnsavedChanges()) return true;
    return window.confirm('Есть несохраненные изменения. Если продолжить, они будут потеряны.');
  }

  function refreshHeaderPreview() {
    const selectedPersonId = getCurrentPersonId();
    const schema = getCurrentSchema();
    if (!selectedPersonId || !inlineDraft || !schema) return;

    const preview = renderEditablePersonDetails(selectedPersonId, inlineDraft, schema, getCurrentDescriptions(), {
      personOptionEntries,
      enumListIdPrefix: 'inlineEditorEnum',
    });
    if (!preview) return;

    personTitle.textContent = preview.title;
    personSubtitle.textContent = preview.subtitle;
  }

  function renderCard(personId, view = null) {
    const dataset = getCurrentDataset();
    const person = dataset?.people?.get(personId);
    if (!person) return;

    const detailsView = view || buildPersonDetailsView(personId, dataset);
    if (!detailsView) return;

    personBody.innerHTML = renderInlinePersonCard({
      personId,
      person,
      detailsView,
      state: {
        activeSectionKey: activeInlineSectionKey,
        loadingSectionKey: inlineLoadingSectionKey,
        savingSectionKey: inlineSavingSectionKey,
        draft: inlineDraft,
        schema: getCurrentSchema(),
        descriptions: getCurrentDescriptions(),
        personOptionEntries,
        statusMessage: inlineStatusMessage,
        statusTone: inlineStatusTone,
        sectionIsDirty: hasUnsavedChanges(),
        isVirtualNode,
      },
    });

    bindPersonLinks(personBody, (linkedId) => {
      onLinkedPersonSelected?.(linkedId);
    });

    bindInlineCardEvents();
  }

  function clearErrorStatus() {
    if (inlineStatusTone !== 'error') return;
    inlineStatusMessage = '';
    inlineStatusTone = 'info';
  }

  function syncDirtyIndicator() {
    const dirtyBadge = personBody.querySelector('.card-section-dirty');
    if (!dirtyBadge) return;

    const isDirty = hasUnsavedChanges();
    const hasInlineError = inlineStatusTone === 'error' && Boolean(inlineStatusMessage);
    dirtyBadge.classList.toggle('is-dirty', isDirty);
    dirtyBadge.classList.toggle('is-error', hasInlineError);
    dirtyBadge.textContent = hasInlineError
      ? inlineStatusMessage
      : isDirty
        ? 'Есть несохранённые изменения'
        : 'Без несохранённых изменений';
  }

  function closeRelationSuggestions(root = personBody) {
    root.querySelectorAll('[data-relation-suggestions]').forEach((panel) => {
      panel.hidden = true;
    });
    root.querySelectorAll('[data-relation-input]').forEach((input) => {
      input.setAttribute('aria-expanded', 'false');
    });
  }

  function closeOtherRelationSuggestions(input) {
    const currentPicker = input.closest('[data-relation-picker]');
    personBody.querySelectorAll('[data-relation-picker]').forEach((picker) => {
      if (picker === currentPicker) return;
      const panel = picker.querySelector('[data-relation-suggestions]');
      const pickerInput = picker.querySelector('[data-relation-input]');
      if (panel) panel.hidden = true;
      pickerInput?.setAttribute('aria-expanded', 'false');
    });
  }

  function isExactRelationValue(value) {
    const raw = String(value || '').trim();
    const dataset = getCurrentDataset();
    if (!raw) return false;
    return dataset?.indexById?.has(raw)
      || optionValueToId.has(raw)
      || personOptionEntries.some((entry) => entry.label === raw || entry.id === raw);
  }

  function openRelationSuggestions(input) {
    if (isExactRelationValue(input.value)) {
      closeRelationSuggestions(personBody);
      return;
    }

    closeOtherRelationSuggestions(input);
    renderRelationSuggestions(input);
  }

  function renderRelationSuggestions(input) {
    const picker = input.closest('[data-relation-picker]');
    const panel = picker?.querySelector('[data-relation-suggestions]');
    if (!panel) return;

    const query = String(input.value || '').trim().toLocaleLowerCase('ru');
    const matches = (query
      ? personOptionEntries.filter((entry) => (
        entry.label.toLocaleLowerCase('ru').includes(query)
        || entry.id.toLocaleLowerCase('ru').includes(query)
      ))
      : personOptionEntries
    ).slice(0, 8);

    panel.innerHTML = `
      <button class="editor-relation-option is-create" type="button" data-action="create-relation-person">
        + Создать новую карточку
      </button>
      ${matches.length
        ? matches.map((entry) => `
            <button class="editor-relation-option" type="button" data-relation-person="${escapeHtml(entry.label)}">
              ${escapeHtml(entry.label)}
            </button>
          `).join('')
        : '<div class="editor-relation-empty">Ничего не найдено</div>'}
    `;
    panel.hidden = false;
    input.setAttribute('aria-expanded', 'true');
  }

  function setRelationInputValue(input, value) {
    input.value = value;
    updateDraftValue(inlineDraft, input.dataset.path, value);
    refreshHeaderPreview();
    syncDirtyIndicator();
  }

  function setNewRelationPersonMessage(message = '', tone = 'neutral') {
    if (!newRelationPersonMessage) return;
    newRelationPersonMessage.textContent = message;
    newRelationPersonMessage.dataset.tone = tone;
  }

  function openNewRelationPersonDialog(input) {
    if (!newRelationPersonDialog || !newRelationPersonSurnameInput || !newRelationPersonFirstNameInput || !newRelationPersonPatronymicInput) return;
    activeRelationCreateInput = input;
    newRelationPersonSurnameInput.value = '';
    newRelationPersonFirstNameInput.value = '';
    newRelationPersonPatronymicInput.value = '';
    setNewRelationPersonMessage('Карточка будет создана при сохранении секции.', 'neutral');

    if (typeof newRelationPersonDialog.showModal === 'function') {
      newRelationPersonDialog.showModal();
    } else {
      newRelationPersonDialog.setAttribute('open', '');
    }

    requestAnimationFrame(() => newRelationPersonSurnameInput?.focus());
  }

  function closeNewRelationPersonDialog() {
    activeRelationCreateInput = null;
    if (!newRelationPersonDialog?.open) return;

    if (typeof newRelationPersonDialog.close === 'function') {
      newRelationPersonDialog.close();
    } else {
      newRelationPersonDialog.removeAttribute('open');
    }
  }

  function addPendingRelationPerson() {
    const nameParts = getNewRelationNameParts();
    const fullName = formatNameParts(nameParts);
    if (!fullName) {
      setNewRelationPersonMessage('Укажите хотя бы одно поле имени.', 'error');
      return;
    }
    if (!activeRelationCreateInput) {
      closeNewRelationPersonDialog();
      return;
    }

    const personId = computeNextPersonId();
    const displayName = `${fullName} [${personId}]`;
    pendingNewPeople.set(personId, {
      id: personId,
      displayName,
      payload: createPendingPersonPayload(personId, nameParts, activeRelationCreateInput),
    });
    optionValueToId.set(displayName, personId);
    personOptionEntries = [
      ...personOptionEntries,
      {
        id: personId,
        label: displayName,
        sortName: fullName,
        hasCustomName: true,
      },
    ].sort((left, right) => left.sortName.localeCompare(right.sortName, 'ru'));
    onLookupsChanged?.(personOptionEntries);
    setRelationInputValue(activeRelationCreateInput, displayName);
    closeRelationSuggestions(personBody);
    closeNewRelationPersonDialog();
  }

  function initializeRelationPickers(root) {
    root.querySelectorAll('[data-relation-picker]').forEach((picker) => {
      const input = picker.querySelector('[data-relation-input]');
      const panel = picker.querySelector('[data-relation-suggestions]');
      if (!input || !panel) return;

      input.addEventListener('click', () => {
        openRelationSuggestions(input);
      });
      input.addEventListener('input', () => {
        clearErrorStatus();
        updateDraftValue(inlineDraft, input.dataset.path, input.value);
        syncDirtyIndicator();
        if (isExactRelationValue(input.value)) {
          closeRelationSuggestions(root);
          return;
        }
        closeOtherRelationSuggestions(input);
        renderRelationSuggestions(input);
      });
      input.addEventListener('keydown', (event) => {
        if (event.key !== 'Enter') return;
        event.preventDefault();
        if (panel.hidden) return;
        const firstOption = panel.querySelector('[data-relation-person]');
        if (firstOption) {
          setRelationInputValue(input, firstOption.dataset.relationPerson);
          closeRelationSuggestions(root);
        }
      });
      panel.addEventListener('click', (event) => {
        const createButton = event.target.closest('[data-action="create-relation-person"]');
        if (createButton) {
          openNewRelationPersonDialog(input);
          return;
        }

        const option = event.target.closest('[data-relation-person]');
        if (!option) return;
        setRelationInputValue(input, option.dataset.relationPerson);
        closeRelationSuggestions(root);
      });
    });
  }

  function bindInlineCardEvents() {
    const selectedPersonId = getCurrentPersonId();
    const schema = getCurrentSchema();

    personBody.querySelectorAll('[data-action="edit-section"]').forEach((button) => {
      button.addEventListener('click', async () => {
        await startSectionEdit(button.dataset.sectionKey);
      });
    });

    personBody.querySelectorAll('[data-action="add-section"]').forEach((button) => {
      button.addEventListener('click', async () => {
        button.closest('.card-add-section-menu')?.removeAttribute('open');
        await startSectionEdit(button.dataset.sectionKey, { addIfMissing: true });
      });
    });

    personBody.querySelector('[data-action="delete-person"]')?.addEventListener('click', async () => {
      await onDeletePersonRequested?.();
    });

    if (!activeInlineSectionKey || !inlineDraft) {
      return;
    }

    personBody.querySelectorAll('[data-path]').forEach((input) => {
      const syncDraftValue = () => {
        const pathString = String(input.dataset.path || '');

        if (pathString.endsWith('.reason') && pathString.includes('name_changes.')) {
          clearErrorStatus();
          syncNameChangeDateField(inlineDraft, pathString, input.value);
          refreshHeaderPreview();
          renderCard(selectedPersonId);
          return;
        }

        updateDraftValue(inlineDraft, pathString, input.value);
        refreshHeaderPreview();
        syncDirtyIndicator();
      };

      input.addEventListener('input', syncDraftValue);
      input.addEventListener('change', syncDraftValue);
    });

    initializeLinkMaskedFields(personBody);
    initializeRelationPickers(personBody);

    personBody.querySelectorAll('[data-action="add-array-item"]').forEach((button) => {
      button.addEventListener('click', () => {
        clearErrorStatus();
        addDraftArrayItem(inlineDraft, schema, button.dataset.arrayPath);
        refreshHeaderPreview();
        renderCard(selectedPersonId);
      });
    });

    personBody.querySelectorAll('[data-action="remove-array-item"]').forEach((button) => {
      button.addEventListener('click', () => {
        clearErrorStatus();
        removeDraftArrayItem(inlineDraft, button.dataset.arrayPath, Number(button.dataset.index));
        refreshHeaderPreview();
        renderCard(selectedPersonId);
      });
    });

    personBody.querySelectorAll('[data-action="toggle-alive"]').forEach((checkbox) => {
      checkbox.addEventListener('change', () => {
        clearErrorStatus();
        setAliveState(inlineDraft, checkbox.checked);
        refreshHeaderPreview();
        renderCard(selectedPersonId);
      });
    });

    personBody.querySelectorAll('[data-action="toggle-divorced"]').forEach((checkbox) => {
      checkbox.addEventListener('change', () => {
        clearErrorStatus();
        setDivorcedState(inlineDraft, checkbox.dataset.divorcePath, checkbox.checked);
        refreshHeaderPreview();
        renderCard(selectedPersonId);
      });
    });

    personBody.querySelectorAll('[data-action="add-other-info-entry"]').forEach((button) => {
      button.addEventListener('click', () => {
        clearErrorStatus();
        addOtherInfoEntry(inlineDraft, button.dataset.otherInfoPath);
        renderCard(selectedPersonId);
      });
    });

    personBody.querySelectorAll('[data-action="remove-other-info-entry"]').forEach((button) => {
      button.addEventListener('click', () => {
        clearErrorStatus();
        removeOtherInfoEntry(inlineDraft, button.dataset.otherInfoPath, button.dataset.otherInfoIndex);
        renderCard(selectedPersonId);
      });
    });

    personBody.querySelector('[data-action="save-inline-section"]')?.addEventListener('click', async () => {
      await saveSection();
    });

    personBody.querySelector('[data-action="cancel-inline-section"]')?.addEventListener('click', () => {
      cancelSectionEdit();
    });

    personBody.querySelector('[data-action="delete-inline-section"]')?.addEventListener('click', async () => {
      await deleteSection();
    });
  }

  async function startSectionEdit(sectionKey, editOptions = {}) {
    const selectedPersonId = getCurrentPersonId();
    const schema = getCurrentSchema();
    const dataset = getCurrentDataset();
    if (!selectedPersonId || !schema || !sectionKey) return false;
    if (activeInlineSectionKey === sectionKey && inlineDraft) return true;
    if (!canDiscardChanges()) return false;

    const targetPersonId = selectedPersonId;
    const requestToken = inlineEditRequestToken + 1;

    inlineStatusMessage = '';
    inlineStatusTone = 'info';
    inlineLoadingSectionKey = sectionKey;
    inlineSavingSectionKey = '';
    inlineEditRequestToken = requestToken;
    renderCard(targetPersonId);

    let sourcePerson = dataset.people.get(targetPersonId);

    try {
      const freshPerson = await loadEditablePerson(targetPersonId);
      if (freshPerson) {
        sourcePerson = freshPerson;
      }
    } catch (error) {
      console.warn('Не удалось загрузить свежую версию карточки для inline-редактора.', error);
      inlineStatusMessage = `Не удалось получить свежие данные из ${getDbLabel()}. Использую текущую версию карточки.`;
      inlineStatusTone = 'info';
    }

    if (getCurrentPersonId() !== targetPersonId || inlineEditRequestToken !== requestToken) {
      return false;
    }

    inlineDraft = hydrateDraftForEditor(sourcePerson, schema, dataset.indexById);

    if (editOptions.addIfMissing && !Object.prototype.hasOwnProperty.call(inlineDraft, sectionKey)) {
      inlineDraft[sectionKey] = createDraftFromSchema({ [sectionKey]: schema[sectionKey] })[sectionKey];
    }

    activeInlineSectionKey = sectionKey;
    inlineOriginalSectionSnapshot = serializeSectionSnapshot(sectionKey, inlineDraft);
    inlineLoadingSectionKey = '';
    refreshHeaderPreview();
    renderCard(targetPersonId);

    const firstInput = personBody.querySelector(`[data-section-key="${sectionKey}"] .editor-input`);
    firstInput?.focus();
    return true;
  }

  function cancelSectionEdit() {
    if (!canDiscardChanges()) return false;

    reset();
    const selectedPersonId = getCurrentPersonId();
    if (selectedPersonId) {
      setSelectedPersonId(selectedPersonId);
      const dataset = getCurrentDataset();
      const result = buildPersonDetailsView(selectedPersonId, dataset);
      if (result) {
        personTitle.textContent = result.title;
        personSubtitle.textContent = result.subtitle;
        renderCard(selectedPersonId, result);
      }
    }
    return true;
  }

  async function deleteSection() {
    if (!activeInlineSectionKey || !inlineDraft || inlineSavingSectionKey) return;

    const sectionLabel = getPersonFieldLabel(activeInlineSectionKey, { context: 'editor' });
    const shouldDelete = window.confirm(`Удалить секцию "${sectionLabel}" из карточки?`);
    if (!shouldDelete) return;

    delete inlineDraft[activeInlineSectionKey];
    refreshHeaderPreview();
    await saveSection();
  }

  async function saveSection() {
    const selectedPersonId = getCurrentPersonId();
    const schema = getCurrentSchema();
    if (!inlineDraft || !schema || !selectedPersonId || !activeInlineSectionKey || inlineSavingSectionKey) return;

    const validation = validateEditorPersonDraft(inlineDraft, schema, {
      peopleById: getPeopleIndexWithPending(),
      optionValueToId,
      requireNonIdContent: false,
    });

    if (!validation.valid) {
      inlineStatusMessage = validation.errors[0] || 'Не удалось проверить карточку.';
      inlineStatusTone = 'error';
      renderCard(selectedPersonId);
      return;
    }

    const nextPersonId = String(validation.normalized.id || '').trim();
    if (!nextPersonId || nextPersonId !== selectedPersonId) {
      inlineStatusMessage = 'Изменение ID существующей карточки во встроенном редакторе пока не поддерживается.';
      inlineStatusTone = 'error';
      renderCard(selectedPersonId);
      return;
    }

    inlineSavingSectionKey = activeInlineSectionKey;
    inlineStatusMessage = '';
    inlineStatusTone = 'info';
    renderCard(selectedPersonId);

    try {
      const pendingPeopleToCreate = Array.from(pendingNewPeople.values());
      for (const pendingPerson of pendingPeopleToCreate) {
        await createEditablePerson(pendingPerson.id, pendingPerson.payload);
      }

      const saveResult = await saveEditablePerson(selectedPersonId, validation.normalized);
      const synchronizedIds = Array.isArray(saveResult?.synchronizedIds) ? saveResult.synchronizedIds : [];
      const skippedIds = Array.isArray(saveResult?.skippedIds) ? saveResult.skippedIds : [];
      const syncMessage = synchronizedIds.length
        ? ` Синхронизированы карточки: ${synchronizedIds.join(', ')}.`
        : '';
      const skippedMessage = skippedIds.length
        ? ` Не удалось обновить карточки: ${skippedIds.join(', ')}.`
        : '';
      const createdMessage = pendingPeopleToCreate.length
        ? ` Созданы карточки: ${pendingPeopleToCreate.map((item) => item.id).join(', ')}.`
        : '';

      inlineStatusMessage = `Изменения сохранены в ${getDbLabel()}.${createdMessage}${syncMessage}${skippedMessage}`;
      inlineStatusTone = 'valid';
      reset({ clearStatus: false });
      await onReloadDatasetAfterSave?.(selectedPersonId);
    } catch (error) {
      console.error(error);
      inlineSavingSectionKey = '';
      inlineStatusMessage = `Не удалось сохранить карточку: ${error.message}`;
      inlineStatusTone = 'error';
      renderCard(selectedPersonId);
    }
  }

  function setupNewRelationPersonDialog() {
    newRelationPersonCreateButton?.addEventListener('click', addPendingRelationPerson);
    [
      newRelationPersonSurnameInput,
      newRelationPersonFirstNameInput,
      newRelationPersonPatronymicInput,
    ].forEach((input) => {
      input?.addEventListener('input', () => setNewRelationPersonMessage('Карточка будет создана при сохранении секции.'));
      input?.addEventListener('keydown', (event) => {
        if (event.key !== 'Enter') return;
        event.preventDefault();
        addPendingRelationPerson();
      });
    });
    newRelationPersonDialog?.addEventListener('click', (event) => {
      if (event.target === newRelationPersonDialog) {
        closeNewRelationPersonDialog();
      }
    });
  }

  function setupDismissHandlers() {
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        closeRelationSuggestions(personBody);
      }
    });

    document.addEventListener('click', (event) => {
      if (event.target.closest?.('[data-relation-picker]')) return;
      closeRelationSuggestions(personBody);
    });
  }

  function isBusy() {
    return Boolean(inlineSavingSectionKey || inlineLoadingSectionKey);
  }

  function setStatus(message = '', tone = 'info') {
    inlineStatusMessage = message;
    inlineStatusTone = tone;
  }

  return {
    refreshLookups,
    reset,
    hasUnsavedChanges,
    canDiscardChanges,
    renderCard,
    resolvePersonLookupTarget,
    formatPersonLookupValue,
    getFilteredPersonOptions,
    setupNewRelationPersonDialog,
    setupDismissHandlers,
    isBusy,
    setStatus,
  };
}
