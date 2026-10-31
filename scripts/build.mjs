#!/usr/bin/env node
/**
 * Build the browser half (`lib/client.js`) as a DSH client-module bundle.
 *
 * ## Why a hand-rolled bundle
 *
 * The Host serves `exports["./client"]` verbatim to the browser, and the shell
 * expects **factory-form CJS** registered on `window.__ModuleLoader__`:
 *
 *   window.__ModuleLoader__.load({
 *     id: "<package name>",
 *     factory: (require) => { var exports = {}; ...; return exports },
 *   })
 *
 * `require` reaches (a) the shell's frozen platform module table —
 * `react`, `react-dom/client`, `@deepseek-ai/dsh-client-ui-primitives`,
 * `@deepseek-ai/cordis`, … — and (b) other plugin bundles. Running that inside
 * esbuild's ESM output would break the lazy-factory model the shell relies on,
 * so the plugin is compiled to CJS and wrapped by hand. The file is then
 * registered under the package name, which is exactly the identity the Host
 * derived from `package.json`, so both halves share one Loader row.
 *
 * Flags:
 *   --check  verify `lib/client.js` is up to date instead of writing it.
 *
 * @module scripts/build
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const entry = join(root, 'src/client.ts')
const output = join(root, 'lib/client.js')
const checkOnly = process.argv.includes('--check')

/** Packages the browser receives from the shell's module table, never bundled. */
const EXTERNALS = [
  'react',
  'react-dom',
  'react-dom/client',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-store',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-dockkit',
  'zod',
]

let esbuild
try {
  esbuild = await import('esbuild')
}
catch {
  console.error(
    'build: esbuild is not installed. Run `npm install` in this package first\n'
    + '       (esbuild is a devDependency; DSH itself never loads it).',
  )
  process.exit(1)
}

const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))

const result = await esbuild.build({
  entryPoints: [entry],
  bundle: true,
  write: false,
  format: 'cjs',
  platform: 'browser',
  target: 'es2022',
  charset: 'utf8',
  legalComments: 'none',
  logLevel: 'warning',
  sourcemap: false,
  // `require` is the loader-provided synchronous require.
  external: EXTERNALS,
  // Keep the free `require` identifier instead of letting esbuild rewrite it.
  define: { 'require': 'require' },
  banner: { js: '// Bundled from src/client.ts — regenerate with `npm run build:client`.' },
})

const [artifact] = result.outputFiles
const code = artifact.text.trimEnd()

const wrapped = `window.__ModuleLoader__.load({
  id: ${JSON.stringify(pkg.name)},
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
${code.split('\n').map(line => (line.length === 0 ? '' : `    ${line}`)).join('\n')}
    return module.exports;
  }
});
`

if (checkOnly) {
  let current = ''
  try {
    current = await readFile(output, 'utf8')
  }
  catch {
    // Missing artifact is an out-of-date artifact.
  }
  if (current !== wrapped) {
    console.error('build: lib/client.js is out of date — run `npm run build:client`')
    process.exit(1)
  }
  console.log('build: lib/client.js is up to date')
}
else {
  await mkdir(dirname(output), { recursive: true })
  await writeFile(output, wrapped)
  console.log(`build: wrote ${output} (${String(Buffer.byteLength(wrapped))} bytes)`)
}