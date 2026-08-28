const badge = document.getElementById('status');

fetch('http://localhost:9999/status')
  .then((r) => r.json())
  .then((data) => {
    badge.textContent = `Dev server connected — watching ${data.files} file(s)`;
    badge.style.background = '#22c55e';
  })
  .catch(() => {
    badge.textContent = 'Dev server offline';
    badge.style.background = '#ef4444';
  });
