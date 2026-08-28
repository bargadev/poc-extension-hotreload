import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'path';

export default defineConfig({
  root: resolve(__dirname, 'src/popup'),
  plugins: [react()],
  build: {
    outDir: resolve(__dirname, 'extension'),
    emptyOutDir: false,
    rollupOptions: {
      input: { popup: resolve(__dirname, 'src/popup/popup.html') },
      output: {
        entryFileNames: '[name].js',
        chunkFileNames: '[name].js',
        assetFileNames: '[name].[ext]',
        manualChunks(id) {
          if (id.includes('react-dom')) return 'react-dom';
          if (id.includes('react'))     return 'react';
        },
      },
    },
  },
});
