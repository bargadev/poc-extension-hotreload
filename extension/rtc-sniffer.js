// PoC: WebRTC caption sniffer + enabler (Tactiq-style mechanism).
// Runs in the MAIN world at document_start so it wraps RTCPeerConnection BEFORE
// Google Meet instantiates its connection. It (1) decodes the `captions` data channel and
// bridges caption text + the participant roster to the sidebar, and (2) — Fase 3 — ENABLES
// captions without the CC button by opening its own `captions` data channel on the SFU
// peer connection AND emitting a caption-language command on the `media-session` channel
// (the channel alone doesn't start Meet's ASR). This bypasses the isTrusted gate on the CC
// toggle. See TACTIQ_NOTES.md.
// Disable the auto-enable with `window.__rtcAutoCaptions = false` before joining.
(() => {
  const TAG = '[RTC-SNIFF]';
  const Native = window.RTCPeerConnection;
  if (!Native || Native.__rtcSniffed) return;

  // Discovery mode: log EVERY channel Meet opens (label names drift between Meet
  // builds), not just the ones from the Tactiq bundle. Once we confirm which label
  // carries caption text we can narrow this back down.
  const WATCH = null; // null = watch all

  // Minimal protobuf reader for ONE caption message (TactiqGoogleMeet):
  //  f1 deviceId(str,tag10) f2 messageId(int,tag16) f3 messageVersion(int,tag24)
  //  f6 text(str,tag50) f8 langId(int,tag64). Skips unknown fields; null unless it has text.
  function parseFlatCaption(u) {
    try {
      let i = 0;
      const out = {};
      const td = new TextDecoder();
      const readVarint = () => {
        // int64 fields (messageId can be large) — accumulate with * 2^shift instead of
        // the 32-bit `<<`/`>>>0`, which would truncate and collide message ids.
        let shift = 0, result = 0;
        while (i < u.length) {
          const b = u[i++];
          result += (b & 0x7f) * Math.pow(2, shift);
          if (!(b & 0x80)) break;
          shift += 7;
        }
        return result;
      };
      while (i < u.length) {
        const tag = readVarint();
        const field = tag >> 3, wire = tag & 7;
        if (wire === 0) {
          const v = readVarint();
          if (field === 2) out.messageId = v;
          else if (field === 3) out.messageVersion = v;
          else if (field === 8) out.langId = v;
        } else if (wire === 2) {
          const len = readVarint();
          const slice = u.subarray(i, i + len);
          i += len;
          if (field === 1) out.deviceId = td.decode(slice);
          else if (field === 6) out.text = td.decode(slice);
        } else if (wire === 1) i += 8;
        else if (wire === 5) i += 4;
        else return null; // group wire types → not this message
      }
      return out.text != null ? out : null;
    } catch {
      return null;
    }
  }

  // Caption packets arrive either flat OR wrapped in an outer message — our auto-enabled
  // channel delivers `{ f1: <caption> }` (sometimes several caption submessages per packet),
  // whereas the CC-on channel sends them flat. Try flat first; otherwise treat every
  // top-level length-delimited field as a caption submessage. Returns an array.
  function decodeCaptions(bytes) {
    const u = new Uint8Array(bytes);
    const flat = parseFlatCaption(u);
    if (flat) return [flat];
    const out = [];
    let i = 0;
    const rv = () => { let s = 0, r = 0; while (i < u.length) { const b = u[i++]; r += (b & 0x7f) * Math.pow(2, s); if (!(b & 0x80)) break; s += 7; } return r; };
    while (i < u.length) {
      const tag = rv(), wire = tag & 7;
      if (wire === 0) rv();
      else if (wire === 1) i += 8;
      else if (wire === 5) i += 4;
      else if (wire === 2) { const len = rv(); const sub = u.subarray(i, i + len); i += len; const c = parseFlatCaption(sub); if (c) out.push(c); }
      else break;
    }
    return out;
  }

  // Pull out runs of printable UTF-8 text from a byte buffer so we can eyeball where
  // caption text ("Olá", names, etc.) actually rides, regardless of the protobuf shape.
  function printableStrings(buf, min = 2) {
    const u = new Uint8Array(buf);
    const td = new TextDecoder('utf-8', { fatal: false });
    const out = [];
    let start = -1;
    for (let i = 0; i <= u.length; i++) {
      const b = u[i];
      const printable = b !== undefined && (b === 0x0a || b === 0x09 || (b >= 0x20 && b !== 0x7f));
      if (printable) {
        if (start < 0) start = i;
      } else {
        if (start >= 0 && i - start >= min) out.push(td.decode(u.subarray(start, i)).trim());
        start = -1;
      }
    }
    return out.filter(Boolean);
  }

  // Participant names are NOT in the caption packet (it only carries a deviceId of the
  // form `spaces/<x>/devices/<y>`). Meet ships the roster (deviceId→deviceName) as a
  // base64 protobuf in the `SyncMeetingSpaceCollections` RPC response. Rather than pin the
  // exact (nested) field numbers, walk the protobuf generically: any submessage that
  // directly holds a device-path string plus one other readable string is a roster entry.
  const DEVICE_RE = /spaces\/[A-Za-z0-9_-]+\/devices\/[A-Za-z0-9_-]+/;
  function extractDevices(bytes) {
    const u = new Uint8Array(bytes);
    const td = new TextDecoder('utf-8', { fatal: false });
    const devices = [];
    function walk(start, end, depth) {
      if (depth > 8) return;
      let i = start;
      const strings = [];
      const subs = [];
      const rv = () => {
        let s = 0, r = 0;
        while (i < end) { const b = u[i++]; r += (b & 0x7f) * Math.pow(2, s); if (!(b & 0x80)) break; s += 7; }
        return r;
      };
      while (i < end) {
        const tag = rv();
        const wire = tag & 7;
        if (wire === 0) rv();
        else if (wire === 1) i += 8;
        else if (wire === 5) i += 4;
        else if (wire === 2) {
          const len = rv();
          const s2 = i, e2 = i + len;
          if (e2 > end) break;
          i = e2;
          strings.push(td.decode(u.subarray(s2, e2)));
          subs.push([s2, e2]);
        } else break;
      }
      const path = strings.find((s) => DEVICE_RE.test(s));
      if (path) {
        const name = strings.find(
          (s) => s !== path && !DEVICE_RE.test(s) && /[A-Za-z]/.test(s) && s.length <= 80 && !/[\x00-\x1f]/.test(s),
        );
        if (name) devices.push({ deviceId: '@' + path.match(DEVICE_RE)[0], deviceName: name.trim() });
      }
      for (const [s2, e2] of subs) { try { walk(s2, e2, depth + 1); } catch { /* not a submessage */ } }
    }
    try { walk(0, u.length, 0); } catch { /* give up */ }
    const seen = new Set();
    return devices.filter((d) => (seen.has(d.deviceId) ? false : (seen.add(d.deviceId), true)));
  }

  function summarize(data) {
    if (typeof data === 'string') return { kind: 'string', len: data.length, sample: data.slice(0, 160) };
    const buf = data instanceof ArrayBuffer ? data : data?.buffer;
    if (!buf) return { kind: typeof data };
    return { kind: 'binary', bytes: buf.byteLength, captions: decodeCaptions(buf), text: printableStrings(buf) };
  }

  function attach(channel, origin) {
    if (!channel || (WATCH && !WATCH.has(channel.label))) return;
    console.log(`${TAG} channel «${channel.label}» (${origin}) state=${channel.readyState}`);
    // Fase 3: media-session carries the seq numbers our language command must match.
    if (channel.label === 'media-session') trackMediaSession(channel);
    channel.addEventListener('message', (ev) => {
      const info = summarize(ev.data);
      if (info.captions && info.captions.length) {
        // Bridge MAIN → ISOLATED (the sidebar): the caption channel and the content-script
        // React app share this DOM `document`, so a CustomEvent here is heard there.
        for (const cap of info.captions) {
          console.log(`${TAG} 📝 [${channel.label}] v${cap.messageVersion} dev=${cap.deviceId}:`, cap.text);
          document.dispatchEvent(new CustomEvent('meet:caption', { detail: cap }));
        }
      } else if (info.text && info.text.length) {
        console.log(`${TAG} 🔤 [${channel.label}] (${info.bytes}b) strings:`, info.text);
      } else {
        console.log(`${TAG} [${channel.label}] msg`, info);
      }
    });
  }

  // ── Fase 3: enable captions without the CC click ──────────────────────────────────
  // Opening a `captions` data channel on the SFU pc is necessary but NOT sufficient: Meet
  // only starts its speech-to-text after it receives a caption-language command on the
  // `media-session` channel. So we (1) open the captions channel and (2) emit that command
  // ourselves — no CC button, no overlay, no isTrusted gate.
  //
  // The command is a protobuf we build by hand (own encoder — schema below), sent as three
  // packets on media-session, using sequence numbers we learn by watching Meet's OWN
  // outgoing media-session packets (so our op/seq are the next valid ones):
  //   BigPacket{ f1 env{ f2 command{ f1 op(varint), f3 captionUpdate{
  //     f1 clientConfig{ f9 captionConfig{ f1 lang_1(str), f2 lang_2(str) } },
  //     f2 fieldMask{ f1 paths(str) } } } } }              ← the language command
  //   SmallPacket{ f1 env{ f1 ack{ f2 seq(varint), f3 ok(varint) } } }  ← x2, seq+1 / seq+2
  // Override language with `window.__rtcLang = 'en-US'` before joining.
  const pVarint = (n) => { const o = []; let x = n; do { let b = x & 0x7f; x = Math.floor(x / 128); if (x > 0) b |= 0x80; o.push(b); } while (x > 0); return o; };
  const pTag = (field, wire) => pVarint((field << 3) | wire);
  const pStr = (s) => { const b = new TextEncoder().encode(s); return [...pVarint(b.length), ...b]; };
  const pLen = (arr) => [...pVarint(arr.length), ...arr];

  function buildLangBig(op, lang) {
    const captionConfig = [...pTag(1, 2), ...pStr(lang), ...pTag(2, 2), ...pStr(lang)];
    const clientConfig = [...pTag(9, 2), ...pLen(captionConfig)];
    const fieldMask = [...pTag(1, 2), ...pStr('client_config.caption_config')];
    const captionUpdate = [...pTag(1, 2), ...pLen(clientConfig), ...pTag(2, 2), ...pLen(fieldMask)];
    const command = [...pTag(1, 0), ...pVarint(op), ...pTag(3, 2), ...pLen(captionUpdate)];
    const envelope = [...pTag(2, 2), ...pLen(command)];
    return new Uint8Array([...pTag(1, 2), ...pLen(envelope)]);
  }
  function buildAck(seq) {
    const ack = [...pTag(2, 0), ...pVarint(seq), ...pTag(3, 0), ...pVarint(1)];
    const envelope = [...pTag(1, 2), ...pLen(ack)];
    return new Uint8Array([...pTag(1, 2), ...pLen(envelope)]);
  }

  // Read the first occurrence of `field` from a protobuf buffer (varint or len-delimited).
  function pField(u, field) {
    let i = 0;
    while (i < u.length) {
      let s = 0, t = 0;
      while (i < u.length) { const b = u[i++]; t += (b & 0x7f) * Math.pow(2, s); if (!(b & 0x80)) break; s += 7; }
      const f = t >> 3, w = t & 7;
      if (w === 0) { let ss = 0, v = 0; while (i < u.length) { const b = u[i++]; v += (b & 0x7f) * Math.pow(2, ss); if (!(b & 0x80)) break; ss += 7; } if (f === field) return { wire: 0, val: v }; }
      else if (w === 2) { let ss = 0, ln = 0; while (i < u.length) { const b = u[i++]; ln += (b & 0x7f) * Math.pow(2, ss); if (!(b & 0x80)) break; ss += 7; } const sl = u.subarray(i, i + ln); i += ln; if (f === field) return { wire: 2, bytes: sl }; }
      else if (w === 1) i += 8; else if (w === 5) i += 4; else break;
    }
    return null;
  }
  const subMsg = (u, field) => { const r = pField(u, field); return r && r.wire === 2 ? r.bytes : null; };
  // Big packet op:  env(f1) → command(f2) → op(f1).  Small packet ack seq: env(f1) → ack(f1) → seq(f2).
  const outOp = (u) => { const e = subMsg(u, 1); if (!e) return; const c = subMsg(e, 2); if (!c) return; const o = pField(c, 1); return o && o.wire === 0 ? o.val : undefined; };
  const outAck = (u) => { const e = subMsg(u, 1); if (!e) return; const a = subMsg(e, 1); if (!a) return; const q = pField(a, 2); return q && q.wire === 0 ? q.val : undefined; };

  let msChannel = null, msLastOp = 0, msLastAck = 0, langEnabled = false, weSend = false;
  const LANG = () => (typeof window.__rtcLang === 'string' && window.__rtcLang) || 'pt-BR';

  // Watch Meet's OWN outgoing media-session packets to learn the live op/ack sequence.
  function trackMediaSession(channel) {
    if (msChannel === channel || !channel || typeof channel.send !== 'function') return;
    msChannel = channel;
    const origSend = channel.send.bind(channel);
    channel.send = function (data) {
      if (!weSend) {
        try {
          const u = data instanceof Uint8Array ? data : new Uint8Array(data.buffer || data);
          const op = outOp(u); if (op != null && op > msLastOp) msLastOp = op;
          const aq = outAck(u); if (aq != null && aq > msLastAck) msLastAck = aq;
        } catch { /* not a packet we track */ }
      }
      return origSend(data);
    };
  }

  function sendLanguageEnable() {
    if (langEnabled || !msChannel || msChannel.readyState !== 'open') return;
    // Meet may not emit an outgoing big command until a user acts, so msLastOp can be 0 —
    // that's fine: op = msLastOp + 1 starts at 1, the next value the server expects (same
    // as Tactiq's `Ua+1`). We only needed the channel open + a moment for seqs to settle.
    langEnabled = true;
    const lang = LANG();
    try {
      weSend = true;
      msChannel.send(buildLangBig(msLastOp + 1, lang));
      msChannel.send(buildAck(msLastAck + 1));
      msChannel.send(buildAck(msLastAck + 2));
      weSend = false;
      console.log(`${TAG} 🗣️ sent caption-language command (${lang}) op=${msLastOp + 1} ack=${msLastAck + 1}/${msLastAck + 2}`);
    } catch (e) {
      weSend = false; langEnabled = false;
      console.warn(`${TAG} language command send failed:`, e && e.message);
    }
  }

  function startLanguagePoll() {
    let tries = 0;
    const iv = setInterval(() => {
      if (langEnabled || window.__rtcAutoCaptions === false) { clearInterval(iv); return; }
      if (tries++ > 40) { clearInterval(iv); console.warn(`${TAG} gave up language command (media-session never opened)`); return; }
      if (tries >= 2) sendLanguageEnable(); // ~1s settle so msLastAck reflects live traffic
    }, 500);
  }

  const SFU_LABELS = new Set(['media-session', 'collections']);
  let captionsPc = null;
  let captionsOpened = false;
  let nextChannelId = 50000; // ++ before use → first id is 50001, matching Tactiq

  function openCaptionsWhenReady(pc) {
    const tryOpen = () => {
      if (captionsOpened || window.__rtcAutoCaptions === false) return;
      if (pc.connectionState && pc.connectionState !== 'connected') return;
      captionsOpened = true;
      try {
        const id = ++nextChannelId;
        pc.createDataChannel('captions', { ordered: true, maxRetransmits: 10, id });
        console.log(`${TAG} ▶️ opened captions channel id=${id} — now sending the language command to start ASR`);
        // Latch a flag too: this fires at document_start, before the React sidebar mounts
        // its listener, so the event alone can be missed. The sidebar checks this on mount.
        window.__captionsEnabled = true;
        document.dispatchEvent(new CustomEvent('meet:captions-enabled', { detail: { id } }));
        startLanguagePoll(); // opening the channel isn't enough — Meet needs the language command
      } catch (e) {
        captionsOpened = false;
        console.warn(`${TAG} could not open captions channel:`, e && e.message);
      }
    };
    tryOpen();
    pc.addEventListener('connectionstatechange', tryOpen);
  }

  function adoptSfuPc(pc, label) {
    if (captionsPc || !SFU_LABELS.has(label)) return;
    captionsPc = pc;
    console.log(`${TAG} adopted SFU pc (saw «${label}») — will open captions channel`);
    openCaptionsWhenReady(pc);
  }

  // Patch createDataChannel on the PROTOTYPE, not per-instance. Meet opens most of its
  // channels (captions, media-session, dcrpc, …) via a path that bypasses an instance
  // override — getStats() shows them alive with traffic while our old per-pc patch only
  // ever saw `collections`. Patching the prototype catches every createDataChannel call
  // no matter how Meet reaches it.
  const protoCreate = Native.prototype.createDataChannel;
  Native.prototype.createDataChannel = function (label, opts) {
    const ch = protoCreate.call(this, label, opts);
    attach(ch, 'local');
    adoptSfuPc(this, label);
    return ch;
  };

  // Roster source: intercept the SyncMeetingSpaceCollections RPC (base64 protobuf) to map
  // deviceId → deviceName, and bridge it to the sidebar. Caption packets only carry the
  // deviceId, so this is what turns "@spaces/…/devices/…" into a real name.
  const origFetch = window.fetch;
  window.fetch = function (input) {
    const url = typeof input === 'string' ? input : (input && input.url) || '';
    const p = origFetch.apply(this, arguments);
    if (url.indexOf('SyncMeetingSpaceCollections') !== -1) {
      p.then((res) => res.clone().text()).then((txt) => {
        try {
          const bytes = Uint8Array.from(atob(txt), (c) => c.charCodeAt(0));
          const devices = extractDevices(bytes);
          if (devices.length) {
            console.log(`${TAG} 👥 roster (${devices.length})`, devices);
            document.dispatchEvent(new CustomEvent('meet:roster', { detail: { devices } }));
          }
        } catch { /* not base64 / not the roster shape */ }
      }).catch(() => {});
    }
    return p;
  };

  function Wrapped(...args) {
    const pc = new Native(...args);
    console.log(`${TAG} RTCPeerConnection created`);

    // Channels Meet opens on its side arrive via ondatachannel.
    pc.addEventListener('datachannel', (ev) => {
      attach(ev.channel, 'remote');
      adoptSfuPc(pc, ev.channel.label);
    });

    window.__rtcSniffPc = pc; // handy for manual poking in DevTools
    return pc;
  }

  Wrapped.prototype = Native.prototype;
  Wrapped.__rtcSniffed = true;
  ['generateCertificate'].forEach((m) => { if (Native[m]) Wrapped[m] = Native[m].bind(Native); });

  window.RTCPeerConnection = Wrapped;
  console.log(`${TAG} installed — waiting for Meet to open a connection`);
})();
