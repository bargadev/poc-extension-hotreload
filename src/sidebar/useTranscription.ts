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

      const speaker = nameFor(d.deviceId);
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

    // Race fix: the sniffer runs in the MAIN world at document_start and fires meet:roster
    // (from SyncMeetingSpaceCollections) and meet:captions-enabled at join time — before this
    // hook mounts. The events are missed, so captions resolve to no name. We can't read the
    // sniffer's window globals (MAIN and ISOLATED share the DOM, not window), so ask over the
    // DOM: the sniffer listens for meet:request-state and replays the current roster + state.
    document.dispatchEvent(new CustomEvent('meet:request-state'));

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
