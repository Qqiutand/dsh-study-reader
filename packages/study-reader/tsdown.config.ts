/**
 * Browser bundle config for the study surface, mirroring the harness client
 * bundle contract: a CJS closure handed to `window.__ModuleLoader__.load`,
 * with platform modules external (resolved from the loader module table) and
 * everything else inlined (the generated study `/remote` contribution and zod).
 */
/** Module-table specifiers seeded by the Harness web shell. */
const PLATFORM_MODULES = [
  'react', 'react/jsx-runtime', 'react-dom', 'react-dom/client', '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-web-react',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-ui-attachment',
  '@deepseek-ai/dsh-client-schema-form',
  '@deepseek-ai/dsh-api-remotes/client',
  '@deepseek-ai/dsh-api-session-controller/client',
]

const ID = 'dsh-study-reader'

export default [
  {
    name: `${ID}/lib`,
    entry: ['lib/types/index.js'],
    outDir: 'lib',
    format: ['esm'],
    platform: 'node',
    target: 'es2024',
    fixedExtension: false,
    dts: false,
    clean: false,
  },
  {
    name: `${ID}/client`,
    entry: { client: 'lib/types/client/index.js' },
    outDir: 'lib',
    format: 'cjs',
    platform: 'browser',
    dts: false,
    sourcemap: true,
    clean: false,
    define: {
      'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'production'),
      'import.meta.env.MODE': JSON.stringify(process.env.NODE_ENV ?? 'production'),
      'import.meta.env': JSON.stringify({ MODE: process.env.NODE_ENV ?? 'production' }),
    },
    // The web shell resolves only these module-table keys. Everything else
    // must be inlined into this closure factory.
    deps: {
      neverBundle: [...PLATFORM_MODULES],
      alwaysBundle: (id: string) => !PLATFORM_MODULES.includes(id),
    },
    outputOptions: {
      entryFileNames: 'client.js',
      // Harness serves only the registered client artifact; split chunks
      // would become relative CommonJS requires the loader cannot serve.
      codeSplitting: false,
      banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(ID)}, factory: (require) => {`,
      footer: 'return module.exports; } });',
      intro: 'var module = { exports: {} }; var exports = module.exports;',
    },
  },
]
