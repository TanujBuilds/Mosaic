import {mkdtemp, mkdir, rm, writeFile, symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';

const run = promisify(execFile);
const native = fileURLToPath(new URL('../', import.meta.url));
const temp = await mkdtemp(path.join(tmpdir(), 'mosaic-preview-host-'));
try {
    const resources = path.join(temp, 'Resources');
    const runtime = path.join(resources, 'runtime');
    const ui = path.join(resources, 'ui');
    await Promise.all(['bin', 'desktop/macos'].map(sub => mkdir(path.join(runtime, sub), {recursive: true})));
    await mkdir(ui);
    await symlink(process.execPath, path.join(runtime, 'bin/node'));
    await writeFile(path.join(runtime, 'desktop/macos/bridge.mjs'), `
        import {writeFile} from 'node:fs/promises';
        let data = ''; for await (const chunk of process.stdin) data += chunk;
        const {method, payload} = JSON.parse(data);
        if (method === 'settings.save' && payload.revision === 'save-in-progress') {
            await writeFile('saving','started');
            await new Promise(resolve => setTimeout(resolve,350));
            await writeFile('saved','ok');
        }
        // This intentionally misbehaving helper tries to echo the entered key.
        const reply = method === 'settings.save' ? {ok:false,error:'failed '+payload.key}
          : method === 'host.connect' ? {ok:true,value:{ok:true,message:'Configured',key:'sensitive'}}
          : method === 'observer.detail' ? {ok:true,value:{host:'Codex'}}
          : {ok:true,value:{host:method, revision:process.argv.length-2, configured:!!process.env.TEST_SECRET_INHERITANCE,readOnlyReason:'Existing host',legacyAvailable:true,serviceMessage:{key:'private'},key:'must-not-return'}};
        console.log(JSON.stringify(reply));
    `);
    await writeFile(path.join(ui, 'index.html'), '<!doctype html><script src="app.js" defer></script>');
    await writeFile(path.join(ui, 'app.js'), `
        const invoke = (method, payload = {}) => window.webkit.messageHandlers.mosaic.postMessage({method,payload});
        async function rejection(method, payload) {
            try { await invoke(method,payload); } catch(error) { return String(error); }
            throw Error('Expected rejection for ' + method);
        }
        (async () => {
            localStorage.setItem('fixture-project', 'project-id');
            if (localStorage.getItem('fixture-project') !== 'project-id') throw Error('WebKit project selection storage');
            const value = await invoke('settings.get');
            if(value.host !== 'settings.get' || value.revision || value.configured || 'key' in value) throw Error('Bad runtime envelope');
            if(value.readOnlyReason !== 'Existing host' || !value.legacyAvailable || 'serviceMessage' in value) throw Error('Public setting health fields');
            const installed = await invoke('host.connect');
            if(!installed.ok || installed.message !== 'Configured' || 'key' in installed) throw Error('Registration status');
            const text = 'fixture follow-up';
            if (!(await invoke('clipboard.copy', {text})).copied) throw Error('Native clipboard');
            if (!(await rejection('host.open',{source:'preview',id:'abc'})).includes('Copy the follow-up')) throw Error('Host fallback');
            if (!(await rejection('unknown',{})).includes('unsupported')) throw Error('Invalid request');
            const secret = 'fake-fixture-credential';
            const error = await rejection('settings.save', {host:'codex',provider:'local',model:'test',baseUrl:'',reviewTarget:'host',
                reviewerModel:'',reviewerBaseUrl:'',revision:null,key:secret});
            if (error.includes(secret)) throw Error('Private value in error');
            window.testResult = {result:'passed'};
        })().catch(error => window.testResult={result:'failed',failure:String(error)});
    `);
    const binary = path.join(temp, 'host-tests');
    const sources = ['Mosaic.swift','Policy.swift','CodexRecent.swift','Runner.swift','tests/HostTests.swift'];
    await run('/usr/bin/xcrun', ['swiftc', '-DMOSAIC_TESTING', '-swift-version', '5', ...sources.map(x => path.join(native, x)), '-o', binary]);
    const result = await run(binary, [resources], {env:{...process.env,TEST_SECRET_INHERITANCE:'private'}, timeout:30000});
    process.stdout.write(result.stdout);
} finally {
    await rm(temp, {recursive:true,force:true});
}
