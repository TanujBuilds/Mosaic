// A scripted host connection for installer CI. Exercise the shipped stdio
// bridge without signing in to an external coding app or requesting inference.
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';

const sdk = path.resolve(path.dirname(process.execPath),
  '../node_modules/@modelcontextprotocol/sdk/dist/esm/client');
const {Client} = await import(pathToFileURL(path.join(sdk, 'index.js')));
const {StdioClientTransport} = await import(pathToFileURL(path.join(sdk, 'stdio.js')));
const client = new Client({name: 'installer-smoke', version: '1.0'});
try {
  await client.connect(new StdioClientTransport({
    command: path.join(os.homedir(), '.local/bin/mosaic'), args: ['mcp'],
    env: {HOME: os.homedir(), PATH: '/usr/bin:/bin'}, stderr: 'inherit',
  }));
  const {tools} = await client.listTools();
  assert.ok(tools.some(tool => tool.name === 'registry_list'));
  const reply = await client.callTool({name: 'registry_list', arguments: {}});
  assert.ok(!reply.isError && reply.content?.length, 'registry_list must return a successful tool result');
} finally {
  await client.close();
}
