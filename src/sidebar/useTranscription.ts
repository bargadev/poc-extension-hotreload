import { useEffect, useRef, useState } from 'react';

export interface TranscriptEntry {
  id: string;
  speaker: string;
  text: string;
  time: string;
  deviceId?: string; // WebRTC source: lets us re-label once the roster resolves the name
}

// The caption toggle in the toolbar. jsname="RrG0hf" is the toggle button itself.
// Fase 2 still needs captions enabled by the user (the `captions` data channel only
// carries data with CC on); Meet gates this button on event.isTrusted, so we can only
// DETECT its state and prompt for one real click — enabling without a click is Fase 3.
const CC_TOGGLE_SELECTORS = ['button[jsname="RrG0hf"]'];

// Shape of the CustomEvents the MAIN-world sniffer (rtc-sniffer.js) dispatches on the
// shared `document`. See extension/rtc-sniffer.js.
interface CaptionDetail {
  deviceId: string;
  messageId: number;
  messageVersion: number;
  text: string;
  langId?: number;
}
interface RosterDetail {
  devices: { deviceId: string; deviceName: string }[];
}

function now(): string {
  return new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
}

function findCcToggle(): HTMLButtonElement | null {
  for (const sel of CC_TOGGLE_SELECTORS) {
    const el = document.querySelector<HTMLButtonElement>(sel);
    if (el) return el;
  }
  return null;
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

  // deviceId → resolved participant name, filled from the SyncMeetingSpaceCollections
  // roster the sniffer forwards. Captions can arrive before the roster, so names are
  // best-effort and back-filled when the roster shows up.
  const rosterRef = useRef<Map<string, string>>(new Map());
  // messageId → { entry id, highest messageVersion seen }. Meet re-sends a speech turn
  // with a rising messageVersion as it refines the text; we key by messageId and keep the
  // latest version, replacing the entry's text in place (same idea Tactiq uses).
  const msgMapRef = useRef<Map<number, { id: string; version: number }>>(new Map());
  const activeRef = useRef(false);

  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;

    function nameFor(deviceId: string): string {
      const r = rosterRef.current;
      const bare = deviceId.replace(/^@/, '');
      return r.get(deviceId) ?? r.get('@' + bare) ?? r.get(bare) ?? 'Participante';
    }

    function onCaption(ev: Event) {
      const d = (ev as CustomEvent<CaptionDetail>).detail;
      if (!d || !d.text) return;

      activeRef.current = true;
      setCcStatus('active');

      const speaker = nameFor(d.deviceId);
      const existing = msgMapRef.current.get(d.messageId);

      if (existing) {
        if (d.messageVersion < existing.version) return; // stale refinement
        existing.version = d.messageVersion;
        setEntries((prev) =>
          prev.map((e) => (e.id === existing.id ? { ...e, text: d.text, speaker } : e)),
        );
      } else {
        const id = uid();
        msgMapRef.current.set(d.messageId, { id, version: d.messageVersion });
        setEntries((prev) => [
          ...prev,
          { id, speaker, text: d.text, time: now(), deviceId: d.deviceId },
        ]);
      }
    }

    function onRoster(ev: Event) {
      const d = (ev as CustomEvent<RosterDetail>).detail;
      if (!d?.devices?.length) return;
      for (const dev of d.devices) {
        if (dev.deviceId && dev.deviceName) rosterRef.current.set(dev.deviceId, dev.deviceName);
      }
      // Back-fill names for entries captured before the roster arrived.
      setEntries((prev) =>
        prev.map((e) => {
          if (!e.deviceId) return e;
          const name = nameFor(e.deviceId);
          return name !== e.speaker ? { ...e, speaker: name } : e;
        }),
      );
    }

    // Fase 3: the sniffer opened the captions channel itself (no CC click). Flip to
    // 'active' right away so the UI doesn't nag "enable captions" while we wait for the
    // first spoken words to arrive.
    function onEnabled() {
      activeRef.current = true;
      setCcStatus('active');
    }

    document.addEventListener('meet:caption', onCaption);
    document.addEventListener('meet:roster', onRoster);
    document.addEventListener('meet:captions-enabled', onEnabled);

    // The sniffer opens the channel at document_start, so meet:captions-enabled may have
    // already fired before this listener mounted. Check the latched flag to catch that case.
    if ((window as unknown as { __captionsEnabled?: boolean }).__captionsEnabled) onEnabled();

    // Until captions are flowing, poll for the CC toggle so the UI can prompt the user to
    // enable them (we never enable them ourselves in Fase 2).
    function tick() {
      if (stopped) return;
      if (!activeRef.current) setCcStatus(findCcToggle() ? 'needs-enable' : 'searching');
      timer = setTimeout(tick, 1000);
    }
    tick();

    return () => {
      stopped = true;
      clearTimeout(timer);
      document.removeEventListener('meet:caption', onCaption);
      document.removeEventListener('meet:roster', onRoster);
      document.removeEventListener('meet:captions-enabled', onEnabled);
    };
  }, []);

  return { entries, ccStatus };
}
