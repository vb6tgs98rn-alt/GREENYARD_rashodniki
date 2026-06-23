import { dom, byId } from './dom.js';

export function setStatus(text) {
  const el = dom.saveStatus();
  if (el) el.textContent = text;
}

export function setTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  const toggle = dom.drawerThemeToggle();
  toggle?.classList.toggle('active', theme === 'dark');
  const label = dom.themeLabel();
  if (label) label.textContent = theme === 'dark' ? 'Тёмная' : 'Светлая';
}

export function openModal(id) {
  const el = byId(id);
  if (!el) return;
  el.classList.add('open');
  el.setAttribute('aria-hidden', 'false');
}

export function closeModal(id) {
  const el = byId(id);
  if (!el) return;
  el.classList.remove('open');
  el.setAttribute('aria-hidden', 'true');
}

export function openDrawer() {
  dom.drawerMenu()?.classList.add('open');
  dom.drawerBackdrop()?.classList.add('open');
}

export function closeDrawer() {
  dom.drawerMenu()?.classList.remove('open');
  dom.drawerBackdrop()?.classList.remove('open');
}
