import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import cssInjectedByJs from 'vite-plugin-css-injected-by-js';
import { resolve } from 'path';

export default defineConfig({
  plugins: [react(), cssInjectedByJs()],
  define: {
    'process.env.NODE_ENV': '"production"',
  },
  build: {
    lib: {
      entry: resolve(__dirname, 'src/sidebar/main.tsx'),
      name: 'MeetSidebar',
      formats: ['iife'],
    },
    outDir: resolve(__dirname, 'extension'),
    emptyOutDir: false,
    rollupOptions: {
      output: {
        entryFileNames: 'googlemeet.inline.js',
        assetFileNames: '[name].[ext]',
      },
    },
  },
});
