import { useEffect, useState } from 'react';

type Status = 'loading' | 'connected' | 'offline';

export default function App() {
  const [status, setStatus] = useState<Status>('loading');
  const [files, setFiles] = useState(0);

  useEffect(() => {
    fetch('http://localhost:9999/status')
      .then((r) => r.json())
      .then((data) => {
        setFiles(data.files);
        setStatus('connected');
      })
      .catch(() => setStatus('offline'));
  }, []);

  const badge: Record<Status, { label: string; bg: string }> = {
    loading: { label: 'loading…', bg: '#94a3b8' },
    connected: { label: `Dev server connected — watching ${files} file(s)`, bg: '#22c55e' },
    offline: { label: 'Dev server offline', bg: '#ef4444' },
  };

  const { label, bg } = badge[status];

  return (
    <div style={{ fontFamily: 'system-ui, sans-serif', width: 240, padding: 16, margin: 0 }}>
      <h2 style={{ margin: '0 0 8px', fontSize: 16 }}>Hot Reload POC — React 2</h2>
      <p style={{ margin: 0, fontSize: 13, color: '#555' }}>
        Edit <code>src/popup/App.tsx</code> and save — extension reloads automatically.
      </p>
      <span
        style={{
          display: 'inline-block',
          marginTop: 10,
          padding: '3px 8px',
          background: bg,
          color: '#fff',
          borderRadius: 4,
          fontSize: 11,
          fontWeight: 600,
        }}
      >
        {label}
      </span>
    </div>
  );
}
