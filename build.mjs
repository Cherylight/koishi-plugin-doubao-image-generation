// Standalone build script for koishi-plugin-doubao-image-generation
// Usage: node build.mjs
// Requires: esbuild (npm i -D esbuild)
import { build } from 'esbuild'

const common = {
  entryPoints: ['src/index.ts'],
  bundle: true,
  platform: 'node',
  target: 'es2022',
  external: [
    'koishi',
    '@koishijs/*',
    'koishi-plugin-chatluna',
    '@langchain/core',
    'zod',
  ],
  charset: 'utf8',
}

await Promise.all([
  build({
    ...common,
    format: 'cjs',
    outfile: 'lib/index.cjs',
  }),
  build({
    ...common,
    format: 'esm',
    outfile: 'lib/index.mjs',
  }),
])

console.log('Build complete: lib/index.cjs + lib/index.mjs')
