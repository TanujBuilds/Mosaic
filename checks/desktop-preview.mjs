import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
const root = new URL('../desktop/macos/', import.meta.url);
const files = {
  ui: ['ui/index.html','ui/app.js','ui/styles.css'],
  connections: ['connections/index.mjs'],
  native: ['native/Mosaic.swift','package.mjs'],
  observer: ['bridge.mjs','board.mjs']
};
const kind = process.argv[2];
assert.ok(Object.hasOwn(files, kind));
for (const file of files[kind]) assert.ok((await readFile(new URL(file,root),'utf8')).trim().length>40,file);
if (kind==='observer') {
  const {projectBoard}=await import(new URL('board.mjs',root));
  const blank=projectBoard({goals:[],tasks:[]});
  assert.deepEqual(blank.cards,[]);assert.deepEqual(blank.projects,[]);
}
if (kind==='ui') {
  const page=await readFile(new URL('ui/index.html',root),'utf8');
  assert.doesNotMatch(page,/<script[^>]+src=["']https?:/i);
}
if (kind==='native') assert.match(await readFile(new URL('package.mjs',root),'utf8'),/hdiutil/);
if (kind==='connections') assert.match(await readFile(new URL('connections/index.mjs',root),'utf8'),/connectionAction/);
console.log('Desktop preview surface verified:',kind);
