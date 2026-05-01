const APP_MENU_HTML = `
  <div id="appMenuOverlay" class="app-menu-overlay" hidden></div>
  <aside id="appSideMenu" class="app-side-menu" aria-hidden="true" aria-label="Меню сайта">
    <div class="app-side-menu-header">
      <h2>Меню</h2>
      <button id="appMenuCloseButton" class="app-menu-close-button" type="button" aria-label="Закрыть меню">×</button>
    </div>
    <nav class="side-menu-nav" aria-label="Разделы">
      <a href="./index.html">Визуализация</a>
      <a href="./documents.html">Документы</a>
      <a href="./edit.html">Редактор</a>
      <a href="./chat.html">ИИ-агент</a>
    </nav>
    <div id="authToolbarSlot" class="side-menu-auth"></div>
  </aside>
`;

export function ensureAppMenu() {
  if (document.getElementById('appSideMenu')) return;

  const header = document.querySelector('.topbar, .editor-topbar');
  if (header) {
    header.insertAdjacentHTML('afterend', APP_MENU_HTML);
    return;
  }

  document.body.insertAdjacentHTML('afterbegin', APP_MENU_HTML);
}
