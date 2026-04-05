const YAML_SCRIPT_URLS = [
  'https://cdn.jsdelivr.net/npm/js-yaml@4.1.0/dist/js-yaml.min.js',
  'https://unpkg.com/js-yaml@4.1.0/dist/js-yaml.min.js',
];

let yamlLibraryPromise = null;

function getGlobalYamlLibrary() {
  const yaml = globalThis?.jsyaml;
  if (!yaml || typeof yaml.load !== 'function' || typeof yaml.dump !== 'function') {
    return null;
  }
  return yaml;
}

function findExistingScript(url) {
  if (typeof document === 'undefined') return null;
  return document.querySelector(`script[data-yaml-url="${url}"]`);
}

function loadYamlScript(url) {
  if (typeof document === 'undefined') {
    return Promise.reject(new Error('Загрузка внешних скриптов недоступна в текущей среде.'));
  }

  const existing = findExistingScript(url);
  if (existing?.dataset.loaded === 'true') {
    return Promise.resolve();
  }

  if (existing?.dataset.loading === 'true') {
    return new Promise((resolve, reject) => {
      existing.addEventListener('load', () => resolve(), { once: true });
      existing.addEventListener('error', () => reject(new Error(`Не удалось загрузить ${url}`)), { once: true });
    });
  }

  return new Promise((resolve, reject) => {
    const script = existing || document.createElement('script');
    script.src = url;
    script.async = true;
    script.dataset.yamlUrl = url;
    script.dataset.loading = 'true';

    script.addEventListener('load', () => {
      script.dataset.loading = 'false';
      script.dataset.loaded = 'true';
      resolve();
    }, { once: true });

    script.addEventListener('error', () => {
      script.dataset.loading = 'false';
      reject(new Error(`Не удалось загрузить ${url}`));
    }, { once: true });

    if (!existing) {
      document.head.append(script);
    }
  });
}

export function getYamlLibrary() {
  const yaml = getGlobalYamlLibrary();
  if (!yaml) {
    throw new Error('Библиотека js-yaml ещё не загружена.');
  }
  return yaml;
}

export async function ensureYamlLibrary() {
  const yaml = getGlobalYamlLibrary();
  if (yaml) return yaml;

  if (!yamlLibraryPromise) {
    yamlLibraryPromise = (async () => {
      let lastError = null;

      for (const url of YAML_SCRIPT_URLS) {
        try {
          await loadYamlScript(url);
          const loadedYaml = getGlobalYamlLibrary();
          if (loadedYaml) return loadedYaml;
        } catch (error) {
          lastError = error;
        }
      }

      const details = lastError instanceof Error ? ` ${lastError.message}` : '';
      throw new Error(`Не удалось загрузить библиотеку js-yaml.${details}`.trim());
    })();
  }

  return yamlLibraryPromise;
}

export async function parseYaml(text) {
  const yaml = await ensureYamlLibrary();
  return yaml.load(text);
}

export async function dumpYaml(value, options = {}) {
  const yaml = await ensureYamlLibrary();
  return yaml.dump(value, options);
}
