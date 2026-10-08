import { rm } from 'node:fs/promises'
import { build } from 'tsdown'

const packageId = 'dsh-ccswitch'

await rm(new URL('../lib', import.meta.url), { recursive: true, force: true })

await build({
  entry: ['src/index.ts'],
  outDir: 'lib',
  format: 'esm',
  platform: 'node',
  target: 'es2022',
  dts: true,
  clean: false,
})

await build({
  entry: { client: 'src/client/index.ts' },
  outDir: 'lib',
  format: 'cjs',
  platform: 'browser',
  // Keep React external: the host page owns the single React instance, and a
  // second copy would break every hook the panel uses.
  deps: { neverBundle: ['react', 'react/jsx-runtime'] },
  target: 'es2022',
  dts: false,
  sourcemap: true,
  clean: false,
  outputOptions: {
    entryFileNames: 'client.js',
    banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(packageId)}, factory: (require) => {`,
    intro: 'var module = { exports: {} }; var exports = module.exports;',
    footer: 'return module.exports; } });',
  },
})
