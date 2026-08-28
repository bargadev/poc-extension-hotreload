import { useEffect, useRef, useState } from 'react';

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

export default function Sidebar() {
  const [notes, setNotes] = useState('');
  const [saved, setSaved] = useState(false);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    loadNotes().then(setNotes);
  }, []);

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
    <div style={{
      display: 'flex',
      flexDirection: 'column',
      height: '100%',
      fontFamily: 'system-ui, sans-serif',
      color: '#e0e0e0',
      padding: '16px',
      boxSizing: 'border-box',
      gap: 8,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <h2 style={{ margin: 0, fontSize: 14, fontWeight: 600, letterSpacing: 0.2 }}>
          NOTAS
        </h2>
        <p>xpto</p>
        {saved && (
          <span style={{ fontSize: 11, color: '#6dcc6d' }}>salvo</span>
        )}
      </div>

      <textarea
        value={notes}
        onChange={handleChange}
        placeholder="Digite suas notas aqui..."
        style={{
          flex: 1,
          resize: 'none',
          background: '#1a1a1a',
          border: '1px solid rgba(255,255,255,0.1)',
          borderRadius: 6,
          color: '#e0e0e0',
          fontSize: 13,
          fontFamily: 'inherit',
          lineHeight: 1.6,
          padding: '10px 12px',
          outline: 'none',
          boxSizing: 'border-box',
        }}
      />
    </div>
  );
}
