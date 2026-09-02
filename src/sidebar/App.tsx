import { useEffect, useRef, useState } from 'react';
import './App.css';
import { useTranscription } from './useTranscription';

const STORAGE_KEY = 'meet-sidebar-notes';

function loadNotes(): Promise<string> {
  return new Promise((resolve) => {
    chrome.storage.local.get(STORAGE_KEY, (result) => {
      resolve(result[STORAGE_KEY] ?? '');
    });
  });
}

function saveNotes(text: string): void {
  chrome.storage.local.set({ [STORAGE_KEY]: text });
}

type Tab = 'transcript' | 'notes';

const SPEAKER_COLORS = [
  '#60a5fa', '#f472b6', '#34d399', '#fb923c',
  '#a78bfa', '#facc15', '#38bdf8', '#4ade80',
];

const speakerColorCache = new Map<string, string>();
let colorIndex = 0;

function colorFor(speaker: string): string {
  if (!speakerColorCache.has(speaker)) {
    speakerColorCache.set(speaker, SPEAKER_COLORS[colorIndex % SPEAKER_COLORS.length]);
    colorIndex++;
  }
  return speakerColorCache.get(speaker)!;
}

export default function Sidebar() {
  const [tab, setTab]       = useState<Tab>('transcript');
  const [notes, setNotes]   = useState('');
  const [saved, setSaved]   = useState(false);
  const saveTimer           = useRef<ReturnType<typeof setTimeout> | null>(null);
  const bottomRef           = useRef<HTMLDivElement>(null);

  const { entries, ccStatus } = useTranscription();

  useEffect(() => { loadNotes().then(setNotes); }, []);

  // Auto-scroll transcript to bottom
  useEffect(() => {
    if (tab === 'transcript') {
      bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
  }, [entries, tab]);

  function handleChange(e: React.ChangeEvent<HTMLTextAreaElement>) {
    const value = e.target.value;
    setNotes(value);
    setSaved(false);
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      saveNotes(value);
      setSaved(true);
    }, 600);
  }

  return (
    <div className="sidebar">
      <div className="sidebar-tabs">
        <button
          className={`sidebar-tab ${tab === 'transcript' ? 'active' : ''}`}
          onClick={() => setTab('transcript')}
        >
          Transcrição
          {entries.length > 0 && (
            <span className="sidebar-badge">{entries.length}</span>
          )}
        </button>
        <button
          className={`sidebar-tab ${tab === 'notes' ? 'active' : ''}`}
          onClick={() => setTab('notes')}
        >
          Notas
          {saved && tab !== 'notes' && <span className="sidebar-dot" />}
        </button>
      </div>

      {tab === 'transcript' && (
        <div className="transcript-feed">
          {ccStatus === 'searching' && (
            <div className="transcript-empty">Procurando controle de legenda…</div>
          )}
          {ccStatus === 'needs-enable' && (
            <div className="transcript-hint">
              <span className="transcript-hint-icon">CC</span>
              <span>Clique no ícone <b>CC</b> na barra do Meet<br />para ativar as legendas</span>
            </div>
          )}
          {ccStatus === 'active' && entries.length === 0 && (
            <div className="transcript-empty">Aguardando falas…</div>
          )}
          {entries.map((entry) => (
            <div key={entry.id} className="transcript-entry">
              <div className="transcript-meta">
                <span
                  className="transcript-speaker"
                  style={{ color: colorFor(entry.speaker) }}
                >
                  {entry.speaker}
                </span>
                <span className="transcript-time">{entry.time}</span>
              </div>
              {entry.text.split('\n').map((line, i) => (
                <p key={i} className="transcript-text">{line}</p>
              ))}
            </div>
          ))}
          <div ref={bottomRef} />
        </div>
      )}

      {tab === 'notes' && (
        <div className="notes-wrapper">
          <div className="sidebar-header">
            <span className="sidebar-title">Notas</span>
            {saved && <span className="sidebar-saved">salvo</span>}
          </div>
          <textarea
            className="sidebar-textarea"
            value={notes}
            onChange={handleChange}
            placeholder="Digite suas notas aqui..."
          />
        </div>
      )}
    </div>
  );
}
