import { copyFileSync, mkdirSync } from 'node:fs';
import * as esbuild from 'esbuild';

const WEB = 'dist/webview';

const extension = {
  entryPoints: ['src/ext/extension.ts'],
  outfile: 'dist/extension.cjs',
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  external: ['vscode'],
  sourcemap: true,
  logLevel: 'info',
};

const webview = {
  entryPoints: ['src/webview/panel.ts', 'src/webview/filters.ts'],
  outdir: WEB,
  bundle: true,
  platform: 'browser',
  format: 'iife',
  target: 'es2022',
  sourcemap: true,
  logLevel: 'info',
};

function copyAssets() {
  mkdirSync(WEB, { recursive: true });
  copyFileSync('media/panel.css', `${WEB}/panel.css`);
  copyFileSync('media/filters.css', `${WEB}/filters.css`);
  copyFileSync('node_modules/@vscode/codicons/dist/codicon.css', `${WEB}/codicon.css`);
  copyFileSync('node_modules/@vscode/codicons/dist/codicon.ttf', `${WEB}/codicon.ttf`);
}

copyAssets();
if (process.argv.includes('--watch')) {
  for (const options of [extension, webview]) {
    await (await esbuild.context(options)).watch();
  }
} else {
  await Promise.all([esbuild.build(extension), esbuild.build(webview)]);
}
