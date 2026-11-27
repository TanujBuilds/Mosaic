import path from 'node:path';
import {canonical} from '../../../src/harness/contracts.mjs';
import {entry,withLock} from '../../../src/beta/files.mjs';
import {validateSettingsCredentials} from '../../../src/beta/settings.mjs';
import {readHostConnection} from '../../../src/beta/hosts/connection-evidence.mjs';
import {codexRegistrations,setupComplete} from '../../../src/beta/setup.mjs';
import {setupPortable} from '../../../src/beta/portable-setup.mjs';
import {ConnectionError,editingReason,localServer,prepareConfiguration,providerOf,selectedProfiles} from './configuration.mjs';
import {testWorker} from './diagnostics.mjs';
import {connectHost,registration} from './registration.mjs';
import {connectionPaths,installedGeneration,installationReason,online,revision as settingsRevision,snapshot,stableBundle} from './lifecycle.mjs';

const conflict='Connections changed in Terminal or another window. Reload Connections before saving again.';

async function pendingReason(paths) {
  for (const [file,command] of [[paths.setupIntent,'setup'],[path.join(paths.configDir,'migration-intent.json'),'migrate'],
    [path.join(paths.configDir,'install-transaction.json'),'recover']])
    if(await entry(file))return 'A shared Mosaic update is pending. Run mosaic '+command+' in Terminal to finish it, then reload Connections.';
  return '';
}

async function info(paths,context,current,blockedReason='') {
  const {settings,credentials,revision}=current;
  const host=settings?.host?.id??'codex', {worker,reviewer}=selectedProfiles(settings);
  const stable=stableBundle(context), serviceReady=Boolean(settings && await online(paths));
  const readOnlyReason=blockedReason || await pendingReason(paths) || editingReason(settings) || await installationReason(paths,settings);
  const history=async source=>Boolean((await entry(path.join(paths.home,'Library','Application Support',source,'state','viewer-connection.json')).catch(()=>null))?.isFile());
  return {
    configured:current.configured??Boolean(settings),host,provider:providerOf(worker),baseUrl:worker?.baseUrl??localServer,model:worker?.model??'',
    hasKey:Boolean(settings?.schema===1 ? settings.worker?.apiKey : worker?.credentialRef && credentials.entries[worker.credentialRef]),
    reviewTarget:settings?.defaults?.review.source??'host',reviewerModel:reviewer?.model??'',reviewerBaseUrl:reviewer?.baseUrl??'',
    reviewerHasKey:Boolean(reviewer?.credentialRef && credentials.entries[reviewer.credentialRef]),
    firstCallAt:settings?.schema===2 ? (await readHostConnection(paths).catch(()=>null))?.at??null : null,
    registration:settings && stable ? registration(paths,host) : '',installedAvailable:await history('Mosaic'),
    legacyAvailable:await history('Mosaic Preview'),revision,serviceReady,readOnlyReason,
    serviceMessage:!stable ? 'Move Mosaic Desktop to Applications and open it there to save connections.'
      : settings && !serviceReady ? 'The shared Mosaic coordinator is offline. Run mosaic doctor in Terminal to check its status.' : ''
  };
}

async function readCurrent(paths) {
  const current=await snapshot(paths);
  if(current.settings)await validateSettingsCredentials(paths,current.settings,current.credentials,{allowMissing:true});
  return current;
}

async function blockedInfo(paths,context,reason) {
  const configured=Boolean((await entry(paths.config).catch(()=>null))?.isFile());
  return info(paths,context,{configured,settings:null,credentials:{entries:{}},
    revision:await settingsRevision(paths).catch(()=>'unavailable')},reason);
}

export async function connectionAction(method,payload,context) {
  try {
    if (!['settings.get','settings.save','worker.test','host.connect'].includes(method) || !payload ||
        typeof payload!=='object' || Array.isArray(payload) || (method!=='settings.save' && Object.keys(payload).length))
      throw new ConnectionError('Unsupported connection request.');
    const paths=connectionPaths(context);
    // A historical or interrupted installation can contain settings the new
    // runtime cannot parse. Show its status and history before touching them.
    const blocked=await pendingReason(paths).catch(()=>'Inspect the shared installation with mosaic doctor in Terminal.')
      || await installationReason(paths,null);
    if (blocked) {
      if(method==='settings.get')return await blockedInfo(paths,context,blocked);
      throw new ConnectionError(blocked);
    }
    if(method==='settings.get') {
      try {return await info(paths,context,await readCurrent(paths));}
      catch {return await blockedInfo(paths,context,'Mosaic Desktop could not read these saved settings. Run mosaic doctor in Terminal to inspect the shared setup.');}
    }
    const current=await readCurrent(paths);
    if(method==='settings.save') {
      if (!stableBundle(context)) throw new ConnectionError('Move Mosaic Desktop to Applications and open it there before saving connections.');
      if (payload.revision!==current.revision) throw new ConnectionError(conflict);
      const reason=editingReason(current.settings) || await installationReason(paths,current.settings);
      if(reason)throw new ConnectionError(reason);
      let installation;
      const {settings,entries}=await prepareConfiguration(payload,current.settings,current.credentials,async()=>{
        const {ensureCore}=await import('../core.mjs');
        const core=await ensureCore(context);
        installation=await installedGeneration(paths);
        return core.nativeCheckRuntime;
      });
      const assertInstallation=async()=>{
        if(await installedGeneration(paths)!==installation || await installationReason(paths,current.settings))throw new ConnectionError('The installed Mosaic version changed. Reload Connections before saving again.');
      };
      if((await snapshot(paths)).revision!==current.revision)throw new ConnectionError(conflict);
      if(canonical(settings)!==canonical(current.settings) ||
          Object.entries(entries).some(([ref,key])=>current.credentials.entries[ref]!==key) || !await setupComplete(paths)) {
        // The bundled desktop adapter supplies the owner's explicit save. The
        // installed terminal and service consume the original portable files.
        await setupPortable(paths,{settings,approvedChange:{previousSettings:current.settings,
          previousCredentials:current.credentials,entries,assertCurrent:assertInstallation},codexRegistrations:codexRegistrations(paths),lifecycle:context.lifecycle});
      }
      return await info(paths,context,await readCurrent(paths));
    }
    if(!current.settings || current.settings.schema===1)
      return {ok:false,message:editingReason(current.settings)||'Save your Mosaic connections first.'};
    if(method==='host.connect' && !stableBundle(context))
      return {ok:false,message:'Open Mosaic Desktop from Applications before registering a coding host.'};
    return await withLock(paths,async()=>{
      if((await snapshot(paths)).revision!==current.revision || await pendingReason(paths))throw new ConnectionError(conflict);
      if(method==='worker.test')return testWorker(current.settings,current.credentials);
      const reason=await installationReason(paths,current.settings);
      if(reason)return {ok:false,message:reason};
      return connectHost(paths,current.settings.host.id);
    });
  } catch(error) {
    if(error instanceof ConnectionError)throw error;
    const message=String(error?.message??'');
    if(/ettings or credentials changed|newer (state|credentials|configuration)|changed during/.test(message))throw new ConnectionError(conflict);
    if(/Another Mosaic Beta maintenance|Another setup/.test(message))throw new ConnectionError('Mosaic is updating its shared setup. Reload Connections when it finishes.');
    if(/pending|incomplete|resum(e|ing).*setup/i.test(message))throw new ConnectionError('A shared update is pending. Run mosaic setup or mosaic recover in Terminal, then reload Connections.');
    if(/prepared|active or unresolved|resumable|finalize/.test(message))throw new ConnectionError('Finish or finalize unresolved Mosaic work in your coding host before saving connections.');
    if(/LaunchAgent|coordinator|maintenance/i.test(message))throw new ConnectionError('The shared coordinator needs attention. Run mosaic doctor in Terminal, then retry.');
    if(/download|checksum/i.test(message))throw new ConnectionError('Could not download and verify the Mosaic runtime. Check your connection and save again.');
    if(/installation|installed|runtime|launcher|Terminal installer/i.test(message))throw new ConnectionError('The Mosaic runtime needs attention. Open your terminal installer to verify the shared installation.');
    if(/credential|Bearer|API key/i.test(message))throw new ConnectionError('Check the private Mosaic credentials and enter API keys only in their password fields.');
    throw new ConnectionError('Could not open or save the shared Mosaic configuration. Run mosaic doctor in Terminal for details.');
  }
}
