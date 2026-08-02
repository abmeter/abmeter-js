import { defineConfig } from 'tsup';

// Three artifacts from one entry point:
//   dist/index.mjs + dist/index.cjs + dist/index.d.ts — the npm package
//   dist/abmeter.iife.min.js — the CDN build (window.abmeter)
export default defineConfig([
  {
    entry: { index: 'src/index.ts' },
    format: ['esm', 'cjs'],
    target: 'es2020',
    dts: true,
    sourcemap: true,
    clean: true,
    outExtension({ format }) {
      return { js: format === 'esm' ? '.mjs' : '.cjs' };
    },
  },
  {
    entry: { 'abmeter.iife': 'src/index.ts' },
    format: ['iife'],
    globalName: 'abmeter',
    target: 'es2020',
    minify: true,
    sourcemap: false,
    outExtension() {
      return { js: '.min.js' };
    },
  },
]);
