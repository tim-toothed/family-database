import { CONFIG, SUPABASE_CONFIG } from './config.js';

const SUPABASE_ESM_URL = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';

let supabaseClientPromise = null;
let authSessionPromise = null;

function hasSupabaseConfig() {
  return Boolean(SUPABASE_CONFIG?.url && SUPABASE_CONFIG?.publishableKey);
}

export async function getSupabaseClient() {
  if (!hasSupabaseConfig()) {
    throw new Error('Supabase не настроен в js/config.js.');
  }

  if (!supabaseClientPromise) {
    supabaseClientPromise = (async () => {
      const { createClient } = await import(SUPABASE_ESM_URL);
      return createClient(SUPABASE_CONFIG.url, SUPABASE_CONFIG.publishableKey, {
        auth: {
          persistSession: true,
          autoRefreshToken: true,
          detectSessionInUrl: true,
          storageKey: 'family-database-auth',
        },
      });
    })();
  }

  return supabaseClientPromise;
}

export async function getSchemaClient() {
  const supabase = await getSupabaseClient();
  return SUPABASE_CONFIG.schema ? supabase.schema(SUPABASE_CONFIG.schema) : supabase;
}

function ensureAuthShell() {
  let shell = document.getElementById('authGate');
  if (shell) return shell;

  shell = document.createElement('section');
  shell.id = 'authGate';
  shell.className = 'auth-gate hidden';
  shell.innerHTML = `
    <form id="authGateForm" class="auth-card">
      <p class="auth-eyebrow">Закрытый семейный архив</p>
      <h2>Вход</h2>
      <p class="auth-copy">Введите email и пароль Supabase. Сессия сохранится в этом браузере.</p>
      <label class="auth-field">
        <span>Email</span>
        <input id="authEmailInput" type="email" autocomplete="email" required />
      </label>
      <label class="auth-field">
        <span>Пароль</span>
        <input id="authPasswordInput" type="password" autocomplete="current-password" required />
      </label>
      <button id="authSubmitButton" type="submit">Войти</button>
      <div id="authStatus" class="auth-status" aria-live="polite"></div>
    </form>
  `;
  document.body.append(shell);
  return shell;
}

function setAuthStatus(message = '', tone = 'neutral') {
  const status = document.getElementById('authStatus');
  if (!status) return;
  status.textContent = message;
  status.dataset.tone = tone;
}

function setAuthFormBusy(isBusy) {
  const submitButton = document.getElementById('authSubmitButton');
  const emailInput = document.getElementById('authEmailInput');
  const passwordInput = document.getElementById('authPasswordInput');
  if (submitButton) {
    submitButton.disabled = Boolean(isBusy);
    submitButton.textContent = isBusy ? 'Проверяю...' : 'Войти';
  }
  if (emailInput) emailInput.disabled = Boolean(isBusy);
  if (passwordInput) passwordInput.disabled = Boolean(isBusy);
}

function renderAuthToolbar(session) {
  if (!CONFIG.requireAuth) return;

  let container = document.getElementById('authToolbar');
  if (!container) {
    container = document.createElement('div');
    container.id = 'authToolbar';
    container.className = 'auth-toolbar';
    const target = document.querySelector('.toolbar, .editor-actions') || document.body;
    target.append(container);
  }

  const email = session?.user?.email || 'пользователь';
  container.innerHTML = `
    <span class="auth-toolbar-email">${email}</span>
    <button id="authSignOutButton" class="toolbar-button toolbar-button-subtle" type="button">Выйти</button>
  `;
  document.getElementById('authSignOutButton')?.addEventListener('click', async () => {
    const supabase = await getSupabaseClient();
    await supabase.auth.signOut();
    window.location.reload();
  });
}

async function waitForPasswordSignIn(supabase) {
  const shell = ensureAuthShell();
  const form = document.getElementById('authGateForm');
  const emailInput = document.getElementById('authEmailInput');
  const passwordInput = document.getElementById('authPasswordInput');
  shell.classList.remove('hidden');

  return new Promise((resolve, reject) => {
    form?.addEventListener('submit', async (event) => {
      event.preventDefault();
      setAuthStatus('');
      setAuthFormBusy(true);

      try {
        const email = String(emailInput?.value || '').trim();
        const password = String(passwordInput?.value || '');
        const { data, error } = await supabase.auth.signInWithPassword({ email, password });
        if (error) throw error;
        if (!data.session) throw new Error('Supabase не вернул сессию.');

        shell.classList.add('hidden');
        renderAuthToolbar(data.session);
        resolve(data.session);
      } catch (error) {
        setAuthStatus(error?.message || 'Не удалось войти.', 'error');
        setAuthFormBusy(false);
      }
    });
  });
}

export async function requireAuth() {
  if (!CONFIG.requireAuth) {
    return null;
  }

  if (!authSessionPromise) {
    authSessionPromise = (async () => {
      const supabase = await getSupabaseClient();
      const { data, error } = await supabase.auth.getSession();
      if (error) throw error;

      if (data.session) {
        renderAuthToolbar(data.session);
        return data.session;
      }

      return waitForPasswordSignIn(supabase);
    })();
  }

  return authSessionPromise;
}
