import { StrictMode } from 'react';
import { createRoot, Root } from 'react-dom/client';
import App from './App';

const SIDEBAR_ID = 'ext-meet-sidebar';
const STYLE_ID   = 'ext-meet-style';
const ROOT_KEY   = '__extMeetRoot__';

declare global {
  interface Window { [ROOT_KEY]: Root | undefined; }
}

function injectShell() {
  if (document.getElementById(SIDEBAR_ID)) return;

  const sidebar = document.createElement('div');
  sidebar.id = SIDEBAR_ID;
  Object.assign(sidebar.style, {
    position:   'fixed',
    right:      '0px',
    top:        '60px',
    bottom:     '80px',
    width:      '320px',
    zIndex:     '100001',
    background: 'rgba(32, 33, 36, 0.97)',
    borderLeft: '1px solid rgba(255,255,255,0.12)',
    boxSizing:  'border-box',
    overflow:   'hidden',
  });
  document.body.appendChild(sidebar);

  if (!document.getElementById(STYLE_ID)) {
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = `main[jscontroller] { right: 336px !important; }`;
    document.head.appendChild(style);
  }
}

function mount() {
  injectShell();
  const el = document.getElementById(SIDEBAR_ID)!;

  // Properly unmount previous root before remounting (hot reload)
  if (window[ROOT_KEY]) {
    try { window[ROOT_KEY]!.unmount(); } catch (_) {}
    window[ROOT_KEY] = undefined;
  }

  const root = createRoot(el);
  window[ROOT_KEY] = root;
  root.render(<StrictMode><App /></StrictMode>);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', mount);
} else {
  mount();
}
