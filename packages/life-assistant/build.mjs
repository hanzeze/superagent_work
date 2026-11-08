import { build } from 'esbuild';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('.', import.meta.url));
await build({
  entryPoints: [`${root}src/index.ts`],
  outfile: `${root}dist/index.js`,
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node22',
  sourcemap: true,
  // Keep DSH singleton services, decorator metadata and Zod schema constructors shared.
  external: ['@deepseek-ai/*', 'zod'],
  tsconfig: `${root}tsconfig.json`,
});
await build({
  entryPoints: [`${root}src/client/index.tsx`],
  outfile: `${root}dist/client.js`,
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: ['chrome125'],
  jsx: 'automatic',
  sourcemap: true,
  external: ['react', 'react/jsx-runtime', '@deepseek-ai/dsh-api-session-controller'],
  banner: { js: 'window.__ModuleLoader__.load({id:"@local/life-assistant",factory:(require)=>{var module={exports:{}};var exports=module.exports;' },
  footer: { js: 'return module.exports;}});' },
  define: { 'process.env.NODE_ENV': '"production"' },
});
// esbuild emits a separate stylesheet; the Host injects the JS bundle.
const cssPath = `${root}dist/client.js`;
const js = await readFile(cssPath, 'utf8');
const css = await readFile(`${root}dist/client.css`, 'utf8');
await writeFile(cssPath, js.replace('return module.exports;}});', `const style=document.createElement('style');style.dataset.plugin='@local/life-assistant';style.textContent=${JSON.stringify(css)};document.head.appendChild(style);return module.exports;}});`));
