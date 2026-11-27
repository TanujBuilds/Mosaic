import {discoverProvider} from '../../../src/beta/provider-diagnostics.mjs';
import {configuredPolicies} from '../../../src/beta/settings.mjs';
import {digest} from '../../../src/harness/contracts.mjs';
import {ProviderRegistry} from '../../../src/harness/providers/registry.mjs';
import {openRouter} from './configuration.mjs';

const messages = {
  authentication:'The provider rejected the saved API key. Replace the key and test again.',
  timeout:'The provider timed out. Check that the server is running and try again.',
  connection:'Could not reach the provider. Check the API base URL and that the server is running.',
  tls:'The provider’s secure connection failed. Check its HTTPS certificate.',
  rate_limit:'The provider rate-limited this connection. Try again later.',
  server:'The provider returned a server error. Try again later.'
};

export async function testWorker(settings,credentials) {
  const profile = settings?.providers.find(p => p.id === settings.defaults.workerId);
  if (!profile) return {ok:false,message:'Save a worker model and API base URL to test its connection.'};
  if(profile.credentialRef && !Object.hasOwn(credentials.entries,profile.credentialRef))
    return {ok:false,message:'The saved worker key is missing. Enter it in Connections and save again.'};
  const catalog = ProviderRegistry({profiles:settings.providers,credentialResolver:async ref => credentials.entries[ref]});
  const api = catalog.createClient({version:1,providerId:profile.id,revision:profile.revision,
    profileHash:digest(catalog.get(profile.id,profile.revision)),policyHash:digest(configuredPolicies(settings).providerPolicy)});
  // OpenRouter publishes its model list. Check authenticated key metadata separately
  // before reporting its key as accepted. The response body can contain key details.
  if (profile.baseUrl === openRouter) {
    let response;
    try {
      response = await fetch(openRouter+'/key',{redirect:'error',signal:AbortSignal.timeout(4500),
        headers:{authorization:'Bearer '+credentials.entries[profile.credentialRef]}});
      await response.body?.cancel();
    } catch { return {ok:false,message:messages.connection}; }
    if (!response.ok) return {ok:false,message:([401,403].includes(response.status) ? messages.authentication : 'OpenRouter could not confirm the saved API key. Try again later.')};
  }
  const report = await discoverProvider(api,profile,{secrets:Object.values(credentials.entries),deadlineMs:5000});
  if (report.discovery.state === 'listed') {
    if (report.discovery.selectedModel !== 'listed') return {ok:false,message:'The provider responded, but its model list is missing the saved model ID.'};
    return {ok:true,message:profile.baseUrl === openRouter ? 'OpenRouter accepted the key and listed the saved model.' : 'The provider responded and listed the saved model.'};
  }
  if (report.discovery.state === 'unsupported') return {ok:false,message:'The provider responded, but does not support the model list check.'};
  return {ok:false,message:messages[report.discovery.category] ?? 'The provider did not return a usable model list. Check its URL, credentials and server status.'};
}
