import { useEffect, useRef, useState } from 'react';

export interface TranscriptEntry {
  id: string;
  speaker: string;
  text: string;
  time: string;
}

// Google Meet caption selectors — verified against Meet's live DOM (2026-08).
// Meet renames classes often, so newest-first with older fallbacks.
const CONTAINER_SELECTORS = [
  '.vNKgIf',                 // current caption region wrapper
  '[aria-label="Legendas"]', // pt-BR region label
  '[aria-label="Captions"]', // en region label
  '[jsname="tgaKEf"]',       // legacy
  '.a4cQT',                  // legacy
];

// Verified against live Meet call DOM (2026-08): row = .nMcdL, speaker = .NWpY1d,
// text = .ygicle. Older class fallbacks kept after the current ones.
const SPEAKER_SELECTORS = ['.NWpY1d', '.zs7s8d', '[data-self-name]', '.KF4T6b'];
const TEXT_SELECTORS    = ['.ygicle', '.bj2sDc', '[jsname="K4EGR"]'];

// The caption toggle in the toolbar. jsname="RrG0hf" is the toggle button itself
// (NOT the settings/scroll buttons that also match aria-label*="legenda").
// NOTE: Meet ignores synthetic clicks on this button (event.isTrusted gate), so we
// cannot force captions on — we detect state and ask the user for one real click.
const CC_TOGGLE_SELECTORS = [
  'button[jsname="RrG0hf"]',
];

// The caption/meeting LANGUAGE selector, unlike the CC toggle, is NOT isTrusted-gated —
// synthetic clicks on its options DO apply (verified live 2026-08). Meet defaults this to
// English, which mis-transcribes Portuguese speech ("olá tudo bem" → "Hola to the bank"),
// so we force the desired language the way Tactiq does.
const CAPTION_LANGUAGE_LABEL   = 'Português (Brasil)';
const OPEN_CC_SETTINGS_LABELS  = ['Abrir configurações de legenda', 'Open caption settings'];
const LANGUAGE_OPTION_SELECTOR = `li[aria-label="${CAPTION_LANGUAGE_LABEL}"]`;

// When captions are on, Meet renders the overlay over the video. We hide it so the
// meeting looks clean (transcript lives only in the sidebar) — same as Tactiq.
// opacity:0 keeps the nodes rendered & updated, so the MutationObserver still reads them.
const HIDE_OVERLAY_STYLE_ID = 'ext-hide-cc-overlay';

// Captions must stay ON for us to read them, but Meet highlights the CC toolbar button
// with a blue pill (bg rgb(168,199,250)) while active. Tactiq keeps the button looking
// inactive, so we restyle it back to the neutral (transparent) toolbar look.
const CC_BUTTON_STYLE_ID = 'ext-neutralize-cc-button';

function now(): string {
  return new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
}

function queryFirst(root: Element | Document, selectors: string[]): Element | null {
  for (const sel of selectors) {
    const el = root.querySelector(sel);
    if (el) return el;
  }
  return null;
}

function findContainer(): Element | null {
  return queryFirst(document, CONTAINER_SELECTORS);
}

function isContainer(el: Element): boolean {
  return CONTAINER_SELECTORS.some((sel) => el.matches(sel));
}

// Read text from a caption row while excluding Meet's own controls that live inside
// the caption region (e.g. the "Ir para o fim" / scroll-to-latest button) and the
// speaker-name element, which would otherwise be concatenated into the transcript.
function cleanText(node: Element): string {
  const clone = node.cloneNode(true) as Element;
  clone.querySelectorAll(['button', '[role="button"]', ...SPEAKER_SELECTORS].join(', '))
    .forEach((b) => b.remove());
  return clone.textContent?.trim() ?? '';
}

// Normalize any mutated node (an added row, or the text node's parent on an in-place
// update) to the caption ROW — the direct child of the caption region that holds both
// speaker and text. Climbing stops at the region so we never grab the whole list.
function captionRowOf(node: Element, container: Element): Element {
  let el = node;
  while (el.parentElement && el.parentElement !== container && !isContainer(el.parentElement)) {
    el = el.parentElement;
  }
  return el;
}

function findCcToggle(): HTMLButtonElement | null {
  for (const sel of CC_TOGGLE_SELECTORS) {
    const el = document.querySelector<HTMLButtonElement>(sel);
    if (el) return el;
  }
  return null;
}

/**
 * Best-effort: attempt to enable captions with a synthetic click.
 * Meet gates the real toggle on event.isTrusted, so this is usually a no-op — the
 * source of truth is whether the caption container subsequently appears. We fire it
 * at most once to avoid toggle-spam if a future Meet build ever honors the click.
 */
function tryEnableCaptions(): boolean {
  const btn = findCcToggle();
  if (!btn) return false;
  btn.click();
  return true;
}

function hideCaptionOverlay() {
  if (document.getElementById(HIDE_OVERLAY_STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = HIDE_OVERLAY_STYLE_ID;
  style.textContent = CONTAINER_SELECTORS.join(', ') +
    ' { opacity: 0 !important; pointer-events: none !important; }';
  document.head.appendChild(style);
}

// Make the (still-active) CC button look inactive, like Tactiq: strip the blue active
// pill and use the neutral toolbar icon color. Captions keep working underneath.
function neutralizeCcButton() {
  if (document.getElementById(CC_BUTTON_STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = CC_BUTTON_STYLE_ID;
  style.textContent = CC_TOGGLE_SELECTORS
    .map((sel) => `${sel}, ${sel}:hover, ${sel}:focus`)
    .join(', ') +
    ' { background-color: transparent !important; color: #e3e3e3 !important; }';
  document.head.appendChild(style);
}

function findCaptionSettingsButton(): HTMLElement | null {
  const btns = document.querySelectorAll<HTMLElement>('button[aria-label]');
  for (const b of btns) {
    if (OPEN_CC_SETTINGS_LABELS.includes(b.getAttribute('aria-label') ?? '')) return b;
  }
  return null;
}

// Click the target-language option. Returns:
//  'done'      — selected (or already selected)
//  'not-ready' — the option isn't rendered yet (caption settings never opened)
function selectCaptionLanguage(): 'done' | 'not-ready' {
  const li = document.querySelector<HTMLElement>(LANGUAGE_OPTION_SELECTOR);
  if (!li) return 'not-ready';
  if (li.getAttribute('aria-selected') !== 'true') li.click();
  return 'done';
}

// Force the caption language to CAPTION_LANGUAGE_LABEL (Tactiq-style). The option list is
// only in the DOM once the caption-settings panel has rendered, so if it isn't there we
// open the panel, pick the language, then close it again to keep the UI clean.
// Runs at most once per active session (guarded by the caller).
function forceCaptionLanguage(onDone: () => void) {
  if (selectCaptionLanguage() === 'done') {
    onDone();
    return;
  }
  const settingsBtn = findCaptionSettingsButton();
  if (!settingsBtn) {
    onDone(); // can't reach it; leave language as-is
    return;
  }
  settingsBtn.click(); // open panel → renders the language list
  setTimeout(() => {
    selectCaptionLanguage();
    // Close the panel again (the same control toggles it).
    findCaptionSettingsButton()?.click();
    onDone();
  }, 600);
}

function extractEntry(node: Element): { speaker: string; text: string } | null {
  // Never treat the whole caption region as a single entry — it contains Meet's
  // controls and every row at once.
  if (isContainer(node)) return null;

  // Skip Meet's own controls that live inside the region (e.g. the scroll-to-latest
  // button). cleanText only strips DESCENDANT controls, so a control that is itself the
  // mutated node would otherwise become a bogus "Participante" entry.
  if (node.matches('button, [role="button"]')) return null;

  const speakerEl = queryFirst(node, SPEAKER_SELECTORS);
  const textEl    = queryFirst(node, TEXT_SELECTORS);

  const text = textEl ? (textEl.textContent?.trim() ?? '') : cleanText(node);
  if (!text) return null;

  return {
    speaker: speakerEl?.textContent?.trim() ?? 'Participante',
    text,
  };
}

let idCounter = 0;
function uid(): string {
  return String(++idCounter);
}

// searching = looking for the CC control; needs-enable = control found but captions off
// (user must click CC — Meet blocks programmatic enabling); active = reading captions.
export type CcStatus = 'searching' | 'needs-enable' | 'active';

export function useTranscription() {
  const [entries, setEntries]   = useState<TranscriptEntry[]>([]);
  const [ccStatus, setCcStatus] = useState<CcStatus>('searching');
  const observerRef             = useRef<MutationObserver | null>(null);
  // Map each Meet caption ROW element to the transcript entry it produced. Meet reuses
  // one row per speaker turn and REWRITES its text in place (refining words/punctuation),
  // so keying by the DOM element — not by a text heuristic — is what keeps a turn as a
  // single entry instead of fragmenting on every rewrite.
  const rowMapRef               = useRef<WeakMap<Element, string>>(new WeakMap());

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    let stopped = false;
    let enableTried = false;
    let languageForced = false;

    function upsertRow(row: Element) {
      const extracted = extractEntry(row);
      if (!extracted) return;

      const { speaker, text } = extracted;
      const existingId = rowMapRef.current.get(row);

      if (existingId) {
        // Same row rewritten → update that entry in place.
        setEntries((prev) =>
          prev.map((e) => (e.id === existingId ? { ...e, speaker, text } : e)),
        );
      } else {
        // New row → new entry, remembered by element for future rewrites.
        const id = uid();
        rowMapRef.current.set(row, id);
        setEntries((prev) => [...prev, { id, speaker, text, time: now() }]);
      }
    }

    function observe(container: Element) {
      setCcStatus('active');
      hideCaptionOverlay();
      neutralizeCcButton();
      if (!languageForced) {
        languageForced = true;
        forceCaptionLanguage(() => {});
      }
      observerRef.current?.disconnect();

      observerRef.current = new MutationObserver((mutations) => {
        for (const mutation of mutations) {
          // Brand-new caption rows appear as added element nodes; normalize each to its
          // caption row so deeply-nested adds still resolve to the speaker+text element.
          mutation.addedNodes.forEach((n) => {
            if (n.nodeType === Node.ELEMENT_NODE) {
              upsertRow(captionRowOf(n as Element, container));
            }
          });

          // In-place growth of the active line reaches us as either a characterData edit
          // (text node data changed) or a childList edit that REPLACES the text node
          // (Meet does both). In both cases derive the caption row from the mutation
          // target and re-extract — the row holds both speaker and (updated) text.
          const target = mutation.target;
          const targetEl =
            target.nodeType === Node.ELEMENT_NODE
              ? (target as Element)
              : target.parentElement;
          if (targetEl && !isContainer(targetEl)) {
            upsertRow(captionRowOf(targetEl, container));
          }
        }
      });

      observerRef.current.observe(container, {
        childList: true,
        subtree: true,
        characterData: true,
      });

      // Initial sweep: the observer only fires on FUTURE mutations, so on attach (e.g. a
      // hot-reload reinject mid-call) we'd miss caption rows already on screen. Pick them
      // up once by resolving each existing text element to its row.
      TEXT_SELECTORS.forEach((sel) =>
        container.querySelectorAll(sel).forEach((tEl) =>
          upsertRow(captionRowOf(tEl, container)),
        ),
      );
    }

    // Poll: once the caption container appears (user enabled CC), read from it.
    // We make ONE best-effort auto-enable attempt; if Meet blocks it (it does), we
    // fall through to 'needs-enable' so the UI prompts for a real click.
    function tick() {
      if (stopped) return;

      const container = findContainer();
      if (container) {
        observe(container);
        return; // observer takes over
      }

      const toggle = findCcToggle();
      if (!toggle) {
        setCcStatus('searching');
      } else {
        if (!enableTried) {
          enableTried = true;
          tryEnableCaptions(); // no-op on current Meet (isTrusted), harmless
        }
        setCcStatus('needs-enable');
      }

      timer = setTimeout(tick, 1000);
    }

    tick();

    return () => {
      stopped = true;
      clearTimeout(timer);
      observerRef.current?.disconnect();
    };
  }, []);

  return { entries, ccStatus };
}
