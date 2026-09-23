import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig(({ isSsrBuild }) => ({
  root: isSsrBuild ? '.' : 'src/frontend',
  plugins: [react(), tailwindcss()],
  resolve: { tsconfigPaths: true },
  build: {
    outDir: isSsrBuild ? 'dist-server' : '../../dist',
    emptyOutDir: true,
  },
}));
