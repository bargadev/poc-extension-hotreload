import { StrictMode } from 'react';
import { createRoot, Root } from 'react-dom/client';
import App from './App';

const SIDEBAR_ID = 'ext-meet-sidebar';
const STYLE_ID   = 'ext-meet-style';
const ROOT_KEY   = '__extMeetRoot__';

declare global {
  interface Window { [ROOT_KEY]: Root | undefined; }
}

let layoutObserver: MutationObserver | null = null;

function applyMeetLayout() {
  const wrapper = document.querySelector('[data-cid="call-screen-wrapper"]:nth-child(1)') as HTMLElement | null;
  if (wrapper && wrapper.style.paddingRight !== '320px') {
    wrapper.style.setProperty('padding-right', '320px', 'important');
  }
}

function startLayoutObserver() {
  if (layoutObserver) return;
  applyMeetLayout();
  layoutObserver = new MutationObserver(applyMeetLayout);
  layoutObserver.observe(document.documentElement, { childList: true, subtree: true, attributeFilter: ['style', 'class'] });
}

function injectShell() {
  if (document.getElementById(SIDEBAR_ID)) return;

  const sidebar = document.createElement('div');
  sidebar.id = SIDEBAR_ID;
  Object.assign(sidebar.style, {
    position:   'fixed',
    right:      '0px',
    top:        '16px',
    bottom:     '80px',
    width:      '320px',
    zIndex:     '100001',
    background: '#141414',
    borderLeft: '1px solid rgba(255,255,255,0.08)',
    boxSizing:  'border-box',
    overflow:   'hidden',
  });
  document.body.appendChild(sidebar);

  if (!document.getElementById(STYLE_ID)) {
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = [
      `body { background: #141414 !important; }`,
      `.crqnQb { max-width: calc(100% - 320px); }`,
      `#root { width: calc(100% - 324px) !important; }`,
    ].join('\n');
    document.head.appendChild(style);
  }

  document.body.classList.add('ext-sidebar-on');
  window.dispatchEvent(new Event('resize'));
  startLayoutObserver();
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
