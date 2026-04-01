import { loadDataset } from './data-loader.js';
import {
  addDraftArrayItem,
  buildPersonOptionEntries,
  hydrateDraftForEditor,
  loadEditorDescriptions,
  loadEditorSchema,
  removeDraftArrayItem,
  renderEditablePersonDetails,
  renderPersonYaml,
  setAliveState,
  updateDraftValue,
  validatePersonDraft,
} from './person-editor.js';

const editorLoading = document.getElementById('editorLoading');
const editorError = document.getElementById('editorError');
const editorShell = document.getElementById('editorShell');
const editorTitle = document.getElementById('editorTitle');
const editorSubtitle = document.getElementById('editorSubtitle');
const editorBody = document.getElementById('editorBody');
const saveYamlButton = document.getElementById('saveYamlButton');
const openYamlButton = document.getElementById('openYamlButton');
const openYamlInput = document.getElementById('openYamlInput');
const validationMessage = document.getElementById('validationMessage');
const personOptions = document.getElementById('editorPersonOptions');

let dataset;
let schema;
let descriptions;
let personId = null;
let draft = null;
let optionValueToId = new Map();

function setBannerMessage(message, tone = 'error') {
  validationMessage.textContent = message;
  validationMessage.classList.toggle('is-error', tone === 'error');
  validationMessage.classList.toggle('is-valid', tone === 'valid');
  validationMessage.classList.toggle('is-info', tone === 'info');
}

function showError(message) {
  editorLoading.hidden = true;
  editorShell.hidden = true;
  editorError.hidden = false;
  editorError.textContent = message;
}

function refreshHeader() {
  const preview = renderEditablePersonDetails(personId, draft, schema, descriptions, {
    personListId: 'editorPersonOptions',
    enumListIdPrefix: 'editorEnum',
  });
  if (!preview) return;
  editorTitle.textContent = preview.title;
  editorSubtitle.textContent = preview.subtitle;
  document.title = `${preview.title} — редактор карточки`;
}

function updateValidationState() {
  const result = validatePersonDraft(draft, schema, {
    peopleById: dataset.indexById,
    optionValueToId,
  });

  saveYamlButton.disabled = !result.valid;
  setBannerMessage(
    result.valid ? 'Карточка готова к сохранению.' : result.errors[0],
    result.valid ? 'valid' : 'error',
  );

  return result;
}

function bindEditorEvents() {
  editorBody.querySelectorAll('[data-path]').forEach((input) => {
    input.addEventListener('input', () => {
      updateDraftValue(draft, input.dataset.path, input.value);
      refreshHeader();
      updateValidationState();
    });
  });

  editorBody.querySelectorAll('[data-action="add-array-item"]').forEach((button) => {
    button.addEventListener('click', () => {
      addDraftArrayItem(draft, schema, button.dataset.arrayPath);
      renderEditor();
    });
  });

  editorBody.querySelectorAll('[data-action="remove-array-item"]').forEach((button) => {
    button.addEventListener('click', () => {
      removeDraftArrayItem(draft, button.dataset.arrayPath, Number(button.dataset.index));
      renderEditor();
    });
  });

  editorBody.querySelectorAll('[data-action="toggle-alive"]').forEach((checkbox) => {
    checkbox.addEventListener('change', () => {
      setAliveState(draft, checkbox.checked);
      renderEditor();
    });
  });
}

function renderEditor() {
  const view = renderEditablePersonDetails(personId, draft, schema, descriptions, {
    personListId: 'editorPersonOptions',
    enumListIdPrefix: 'editorEnum',
  });
  if (!view) {
    showError('Не удалось построить форму редактирования.');
    return;
  }

  editorTitle.textContent = view.title;
  editorSubtitle.textContent = view.subtitle;
  editorBody.innerHTML = view.html;
  bindEditorEvents();
  updateValidationState();
}

function populatePersonOptions() {
  const { entries, optionValueToId: lookup } = buildPersonOptionEntries(dataset);
  optionValueToId = lookup;
  personOptions.innerHTML = entries
    .map((entry) => `<option value="${entry.label}"></option>`)
    .join('');
}

function downloadYaml() {
  const validation = updateValidationState();
  if (!validation.valid) return;

  const yamlText = renderPersonYaml(validation.normalized, schema);
  const blob = new Blob([yamlText], { type: 'text/yaml;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `${personId}.yaml`;
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function derivePersonIdFromFile(fileName, parsedYaml) {
  const yamlId = String(parsedYaml?.id || '').trim();
  if (yamlId) return yamlId;

  const stem = String(fileName || '').replace(/\.(yaml|yml)$/i, '').trim();
  return stem || personId;
}

async function loadYamlFromFile(file) {
  try {
    const text = await file.text();
    const parsed = jsyaml.load(text);

    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      setBannerMessage('Не удалось загрузить YAML: файл должен содержать объект карточки.', 'error');
      return;
    }

    const loadedPersonId = derivePersonIdFromFile(file.name, parsed);
    personId = loadedPersonId;
    draft = hydrateDraftForEditor(parsed, schema, dataset.indexById);

    const nextUrl = new URL(window.location.href);
    nextUrl.searchParams.set('id', personId);
    window.history.replaceState({}, '', nextUrl);

    editorError.hidden = true;
    renderEditor();
    setBannerMessage(`Локальный файл ${file.name} загружен.`, 'info');
  } catch (error) {
    console.error(error);
    setBannerMessage(`Не удалось прочитать YAML: ${error.message}`, 'error');
  }
}

function setupToolbarActions() {
  openYamlButton.addEventListener('click', () => {
    openYamlInput.click();
  });

  openYamlInput.addEventListener('change', async () => {
    const [file] = openYamlInput.files || [];
    if (!file) return;
    await loadYamlFromFile(file);
    openYamlInput.value = '';
  });

  saveYamlButton.addEventListener('click', downloadYaml);
}

async function init() {
  try {
    const params = new URLSearchParams(window.location.search);
    personId = params.get('id');

    if (!personId) {
      showError('Не указан ID карточки. Откройте редактор с основной страницы.');
      return;
    }

    const [loadedDataset, loadedSchema, loadedDescriptions] = await Promise.all([
      loadDataset(),
      loadEditorSchema(),
      loadEditorDescriptions(),
    ]);

    dataset = loadedDataset;
    schema = loadedSchema;
    descriptions = loadedDescriptions;

    const person = dataset.people.get(personId);
    if (!person) {
      showError(`Карточка ${personId} не найдена.`);
      return;
    }

    populatePersonOptions();
    draft = hydrateDraftForEditor(person, schema, dataset.indexById);
    renderEditor();

    editorLoading.remove();
    editorError.hidden = true;
    editorShell.hidden = false;

    setupToolbarActions();
  } catch (error) {
    console.error(error);
    showError(`Не удалось открыть редактор.\n\n${error.message}`);
  }
}

init();
