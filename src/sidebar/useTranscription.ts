import { useEffect, useRef, useState } from 'react';

export interface TranscriptEntry {
  id: string;
  speaker: string;
  text: string;
  time: string;
  deviceId?: string; // WebRTC source: lets us re-label once the roster resolves the name
  kind?: 'speech' | 'chat'; // chat messages ride the transcript too, marked distinctly
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
interface ChatDetail {
  deviceId: string;
  timestamp?: number;
  text: string;
}

function now(): string {
  return new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
}

// Names are NOT in the WebRTC packets — only a deviceId (`spaces/…/devices/…`). The
// SyncMeetingSpaceCollections fetch carries the roster, but Meet does NOT re-fetch it for
// participants who join/rejoin LATER (device numbers climb on every rejoin), so late
// speakers resolved to "Participante". The Meet DOM, however, always tags every rendered
// tile with `data-participant-id="spaces/…/devices/…"` and embeds the display name in the
// tile's action aria-labels ("Fixar <name> na tela principal", "Mais opções para <name>").
// Reading that gives an authoritative, live-updating deviceId→name map for every visible
// participant — the reliable source we key names on.
const NAME_LABEL_PATTERNS = [
  /^Fixar (.+?) na tela/i,
  /^Desafixar (.+?) da tela/i,
  /^Mais opções para (.+)$/i,
  /^Pin (.+?) to/i,
  /^Unpin (.+?) from/i,
  /^More options for (.+)$/i,
];

function nameFromLabels(labels: string[]): string {
  for (const l of labels) {
    for (const re of NAME_LABEL_PATTERNS) {
      const m = l.match(re);
      if (m && m[1]) return m[1].trim();
    }
  }
  return '';
}

// Walk up from a tile element collecting aria-labels until one yields a participant name.
function nameForTile(start: Element): string {
  let node: Element | null = start;
  for (let up = 0; up < 6 && node; up++) {
    const labels: string[] = [];
    const self = node.getAttribute('aria-label');
    if (self) labels.push(self);
    node.querySelectorAll('[aria-label]').forEach((n) => {
      const a = n.getAttribute('aria-label');
      if (a) labels.push(a);
    });
    const nm = nameFromLabels(labels);
    if (nm) return nm;
    node = node.parentElement;
  }
  return '';
}

// Scan the Meet DOM for the current deviceId→name map. Keyed on the bare device path
// (`spaces/…/devices/…`, no leading @) to match nameFor's normalization.
function scanDomRoster(): Map<string, string> {
  const map = new Map<string, string>();
  document.querySelectorAll('[data-participant-id]').forEach((el) => {
    const id = el.getAttribute('data-participant-id') || '';
    if (!/devices\//.test(id) || map.has(id)) return;
    const nm = nameForTile(el);
    if (nm) map.set(id, nm);
  });
  return map;
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
  // Meet emits captions as a stream of segments: each segment has its own messageId and is
  // refined in place via a rising messageVersion. During continuous speech it issues many
  // messageIds in a row for the same speaker. We group consecutive same-speaker segments
  // into ONE block (like Tactiq) instead of one row per segment, breaking a block only when
  // the speaker changes or after a long pause.
  //   blocksRef:  blockId → the block's segments (source of truth for its joined text)
  //   msgMapRef:  "deviceId:messageId" → which block a refinement routes to
  //   currentRef: the block new segments append to (null until the first caption)
  // NOTE: messageId is NOT global — Meet numbers it per-device (each speaker restarts at a
  // low value), so two speakers routinely share the same messageId. Routing MUST key on
  // deviceId+messageId, or one speaker's refinement lands in the other's block.
  interface Segment { messageId: number; version: number; text: string; lastTime: number }
  interface Block { deviceId: string; lastTime: number; segments: Segment[] }
  const blocksRef = useRef<Map<string, Block>>(new Map());
  const msgMapRef = useRef<Map<string, string>>(new Map()); // "deviceId:messageId" → blockId
  const currentRef = useRef<{ blockId: string; deviceId: string } | null>(null);
  const activeRef = useRef(false);
  // Dedup chat: the same packet can be redelivered and own sends echo on two channels.
  // Key on deviceId + timestamp + text.
  const chatSeenRef = useRef<Set<string>>(new Set());

  // Start a new block when the same speaker resumes after a gap this long (ms).
  const BLOCK_GAP_MS = 10_000;
  // Meet also REUSES a (device, messageId) after the speaker pauses and speaks again,
  // replacing the text with an unrelated sentence (versions keep climbing, so it looks
  // like a refinement). ASR revisions of the SAME utterance land within seconds; a reused
  // id comes tens of seconds later. If a known segment hasn't been touched in this long,
  // treat the next caption for it as a NEW turn instead of overwriting the old text.
  const SEGMENT_REUSE_MS = 15_000;

  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;

    function nameFor(deviceId: string): string {
      const r = rosterRef.current;
      const bare = deviceId.replace(/^@/, '');
      return r.get(deviceId) ?? r.get('@' + bare) ?? r.get(bare) ?? 'Participante';
    }

    function isKnown(deviceId: string): boolean {
      const r = rosterRef.current;
      const bare = deviceId.replace(/^@/, '');
      return r.has(deviceId) || r.has('@' + bare) || r.has(bare);
    }

    // Pull the latest deviceId→name map from the Meet DOM into rosterRef (DOM is
    // authoritative — it overrides any stale/garbled name from the fetch/data-channel
    // roster) and back-fill entries whose speaker was still unresolved.
    function applyDomRoster() {
      const dom = scanDomRoster();
      if (!dom.size) return;
      let changed = false;
      for (const [id, nm] of dom) {
        if (rosterRef.current.get(id) !== nm) {
          rosterRef.current.set(id, nm);
          changed = true;
        }
      }
      if (!changed) return;
      setEntries((prev) =>
        prev.map((e) => {
          if (!e.deviceId) return e;
          const name = nameFor(e.deviceId);
          return name !== e.speaker ? { ...e, speaker: name } : e;
        }),
      );
    }

    // Resolve a name for a device we're about to render. If it's not in the roster yet,
    // scan the DOM on demand so a brand-new speaker's first caption already shows their real
    // name instead of "Participante".
    function resolveName(deviceId: string): string {
      if (!isKnown(deviceId)) applyDomRoster();
      return nameFor(deviceId);
    }

    // One line per utterance segment (Tactiq shows each as its own paragraph under the
    // speaker header), newline-joined; App splits on \n to render separate paragraphs.
    function blockText(b: Block): string {
      return b.segments.map((s) => s.text.trim()).filter(Boolean).join('\n');
    }

    function onCaption(ev: Event) {
      const d = (ev as CustomEvent<CaptionDetail>).detail;
      if (!d || !d.text) return;

      activeRef.current = true;
      setCcStatus('active');

      const speaker = resolveName(d.deviceId);
      const nowMs = Date.now();
      const key = d.deviceId + ':' + d.messageId; // messageId is per-device; scope it
      const knownBlockId = msgMapRef.current.get(key);

      // Refinement of a segment we've already seen: update its text in place, keep the
      // highest version, and re-join the block it belongs to.
      if (knownBlockId) {
        const block = blocksRef.current.get(knownBlockId);
        const seg = block?.segments.find((s) => s.messageId === d.messageId);
        if (block && seg && nowMs - seg.lastTime <= SEGMENT_REUSE_MS) {
          if (d.messageVersion < seg.version) return; // stale refinement
          seg.version = d.messageVersion;
          seg.text = d.text;
          seg.lastTime = nowMs;
          block.lastTime = nowMs;
          const text = blockText(block);
          setEntries((prev) => prev.map((e) => (e.id === knownBlockId ? { ...e, text, speaker } : e)));
          return;
        }
        // Known id but the segment is stale (or gone): Meet reused this messageId for a new
        // turn after a pause. Drop the mapping and fall through to open a fresh segment.
        msgMapRef.current.delete(key);
      }

      // New segment. Append to the current block if it's the same speaker still talking;
      // otherwise (speaker changed, or long pause) open a new block.
      const cur = currentRef.current;
      const curBlock = cur ? blocksRef.current.get(cur.blockId) : undefined;
      const continues =
        cur && curBlock && cur.deviceId === d.deviceId && nowMs - curBlock.lastTime <= BLOCK_GAP_MS;

      if (continues && curBlock) {
        curBlock.segments.push({ messageId: d.messageId, version: d.messageVersion, text: d.text, lastTime: nowMs });
        curBlock.lastTime = nowMs;
        msgMapRef.current.set(key, cur!.blockId);
        const text = blockText(curBlock);
        setEntries((prev) => prev.map((e) => (e.id === cur!.blockId ? { ...e, text, speaker } : e)));
      } else {
        const blockId = uid();
        const block: Block = {
          deviceId: d.deviceId,
          lastTime: nowMs,
          segments: [{ messageId: d.messageId, version: d.messageVersion, text: d.text, lastTime: nowMs }],
        };
        blocksRef.current.set(blockId, block);
        currentRef.current = { blockId, deviceId: d.deviceId };
        msgMapRef.current.set(key, blockId);
        setEntries((prev) => [
          ...prev,
          { id: blockId, speaker, text: d.text, time: now(), deviceId: d.deviceId },
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

    // A chat message the sniffer decoded off the WebRTC `collections` channel (everyone's
    // chat, not just ours — Tactiq's source). It becomes its own standalone transcript entry
    // (never merged into a speech block), marked kind:'chat' so the UI can flag it, so chat
    // and speech interleave chronologically. Sender is resolved from the roster by deviceId,
    // exactly like captions — so Carol's chat shows "Carol Damilano", never "Participante".
    function onChat(ev: Event) {
      const d = (ev as CustomEvent<ChatDetail>).detail;
      if (!d || !d.text) return;

      // Dedup: the same chat packet can be redelivered, and own sends echo on both channels.
      const cid = d.deviceId + ':' + (d.timestamp ?? '') + ':' + d.text;
      if (chatSeenRef.current.has(cid)) return;
      chatSeenRef.current.add(cid);

      activeRef.current = true;
      setCcStatus('active');

      // Chat interrupts the current speech block: the next spoken segment must open a fresh
      // block rather than appending under a chat line.
      currentRef.current = null;

      setEntries((prev) => [
        ...prev,
        { id: uid(), speaker: resolveName(d.deviceId), text: d.text, time: now(), kind: 'chat' },
      ]);
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
    document.addEventListener('meet:chat', onChat);
    document.addEventListener('meet:captions-enabled', onEnabled);

    // Race fix: the sniffer runs in the MAIN world at document_start and fires meet:roster
    // (from SyncMeetingSpaceCollections) and meet:captions-enabled at join time — before this
    // hook mounts. The events are missed, so captions resolve to no name. We can't read the
    // sniffer's window globals (MAIN and ISOLATED share the DOM, not window), so ask over the
    // DOM: the sniffer listens for meet:request-state and replays the current roster + state.
    document.dispatchEvent(new CustomEvent('meet:request-state'));

    // Until captions are flowing, poll for the CC toggle so the UI can prompt the user to
    // enable them (we never enable them ourselves in Fase 2).
    // Seed the DOM roster immediately so names are ready before the first caption.
    applyDomRoster();

    function tick() {
      if (stopped) return;
      if (!activeRef.current) setCcStatus(findCcToggle() ? 'needs-enable' : 'searching');
      // Keep names fresh: participants join/rename/rejoin (new device numbers) mid-call, and
      // the DOM reflects that live. Cheap for a normal-sized meeting.
      applyDomRoster();
      timer = setTimeout(tick, 1000);
    }
    tick();

    return () => {
      stopped = true;
      clearTimeout(timer);
      document.removeEventListener('meet:caption', onCaption);
      document.removeEventListener('meet:roster', onRoster);
      document.removeEventListener('meet:chat', onChat);
      document.removeEventListener('meet:captions-enabled', onEnabled);
    };
  }, []);

  return { entries, ccStatus };
}
