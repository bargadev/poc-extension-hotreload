// PoC: WebRTC caption sniffer (Tactiq-style mechanism).
// Runs in the MAIN world at document_start so it wraps RTCPeerConnection BEFORE
// Google Meet instantiates its connection. Read-only: it only LOGS the data-channel
// traffic so we can confirm captions flow over the "captions" channel and match the
// protobuf we reverse-engineered (see TACTIQ_NOTES.md). It enables nothing yet.
(() => {
  const TAG = '[RTC-SNIFF]';
  const Native = window.RTCPeerConnection;
  if (!Native || Native.__rtcSniffed) return;

  // Discovery mode: log EVERY channel Meet opens (label names drift between Meet
  // builds), not just the ones from the Tactiq bundle. Once we confirm which label
  // carries caption text we can narrow this back down.
  const WATCH = null; // null = watch all

  // Minimal protobuf reader for the caption message shape TactiqGoogleMeet:
  //  f1 deviceId(str,tag10) f2 messageId(int,tag16) f3 messageVersion(int,tag24)
  //  f6 text(str,tag50) f8 langId(int,tag64). Best-effort; returns null on anything odd.
  function decodeCaption(bytes) {
    try {
      const u = new Uint8Array(bytes);
      let i = 0;
      const out = {};
      const readVarint = () => {
        let shift = 0, result = 0;
        while (i < u.length) {
          const b = u[i++];
          result |= (b & 0x7f) << shift;
          if (!(b & 0x80)) break;
          shift += 7;
        }
        return result >>> 0;
      };
      const td = new TextDecoder();
      while (i < u.length) {
        const tag = u[i++];
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
        } else {
          return null; // unexpected wire type → not this message
        }
      }
      return out.text != null ? out : null;
    } catch {
      return null;
    }
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

  function summarize(data) {
    if (typeof data === 'string') return { kind: 'string', len: data.length, sample: data.slice(0, 160) };
    const buf = data instanceof ArrayBuffer ? data : data?.buffer;
    if (!buf) return { kind: typeof data };
    return { kind: 'binary', bytes: buf.byteLength, caption: decodeCaption(buf), text: printableStrings(buf) };
  }

  function attach(channel, origin) {
    if (!channel || (WATCH && !WATCH.has(channel.label))) return;
    console.log(`${TAG} channel «${channel.label}» (${origin}) state=${channel.readyState}`);
    channel.addEventListener('message', (ev) => {
      const info = summarize(ev.data);
      if (info.caption) {
        console.log(`${TAG} 📝 [${channel.label}] v${info.caption.messageVersion} dev=${info.caption.deviceId}:`, info.caption.text);
      } else if (info.text && info.text.length) {
        console.log(`${TAG} 🔤 [${channel.label}] (${info.bytes}b) strings:`, info.text);
      } else {
        console.log(`${TAG} [${channel.label}] msg`, info);
      }
    });
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
    return ch;
  };

  function Wrapped(...args) {
    const pc = new Native(...args);
    console.log(`${TAG} RTCPeerConnection created`);

    // Channels Meet opens on its side arrive via ondatachannel.
    pc.addEventListener('datachannel', (ev) => attach(ev.channel, 'remote'));

    window.__rtcSniffPc = pc; // handy for manual poking in DevTools
    return pc;
  }

  Wrapped.prototype = Native.prototype;
  Wrapped.__rtcSniffed = true;
  ['generateCertificate'].forEach((m) => { if (Native[m]) Wrapped[m] = Native[m].bind(Native); });

  window.RTCPeerConnection = Wrapped;
  console.log(`${TAG} installed — waiting for Meet to open a connection`);
})();
