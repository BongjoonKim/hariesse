import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// 백엔드 타입(`../src/lib/types.ts`)을 타입 전용으로 import하므로 루트 밖 접근을 허용한다.
export default defineConfig({
  plugins: [react()],
  build: { outDir: 'dist', emptyOutDir: true },
  server: {
    fs: { allow: ['..'] },
    // 로컬 개발용 — 실제 배포에서는 CloudFront가 같은 오리진으로 붙여준다.
    proxy: { '/api': { target: process.env.HARIESSE_API ?? 'http://localhost:3000', changeOrigin: true } },
  },
});
