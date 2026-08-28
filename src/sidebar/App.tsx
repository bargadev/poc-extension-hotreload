import { useEffect, useRef, useState } from 'react';
import './App.css';

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
    <div className="sidebar">
      <div className="sidebar-header">
        <h2 className="sidebar-title">NOTAS</h2>
        {saved && <span className="sidebar-saved">salvo</span>}
      </div>
      <textarea
        className="sidebar-textarea"
        value={notes}
        onChange={handleChange}
        placeholder="Digite suas notas aqui..."
      />
    </div>
  );
}
