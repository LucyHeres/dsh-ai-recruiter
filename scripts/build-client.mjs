import { build } from 'esbuild'
import { writeFile } from 'node:fs/promises'
const result = await build({ entryPoints: ['src/client/index.tsx'], bundle: true, write: false, format: 'cjs', platform: 'browser', target: 'es2022', loader: { '.css': 'text' }, external: ['react', 'react/*', '@deepseek-ai/*'], jsx: 'automatic' })
// DSH materializes this factory after its dependency factories have arrived.
await writeFile('dist/client.js', `window.__ModuleLoader__.load({id:"dsh-ai-recruiter",factory:(require)=>{\nvar module={exports:{}};var exports=module.exports;\n${result.outputFiles[0].text}\nreturn module.exports;\n}});\n`)
