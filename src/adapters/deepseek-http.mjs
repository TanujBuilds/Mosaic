import http from 'node:http';
import https from 'node:https';
import {workerEndpoint} from '../harness/worker-profile.mjs';
import { providedRetryHint, responseRetryHint } from './retry-after.mjs';

function endpoint(baseUrl, openAICompatible) {
  if (openAICompatible) {
    try { return new URL(workerEndpoint(baseUrl) + '/'); }
    catch (error) { throw requestError(error.message); }
  }
  const message = 'DeepSeek base URL must use HTTP or HTTPS';
  let url;
  try {
    url = new URL(baseUrl.endsWith('/') ? baseUrl : baseUrl + '/');
  } catch {
    throw requestError(message);
  }
  if (!['http:', 'https:'].includes(url.protocol)) throw requestError(message);
  return url;
}

const providerErrorCodes=new Set(['model_not_found','context_length_exceeded']);
const diagnosticCategories=new Set(['address','tls','connection','timeout','cancelled','protocol','configuration','model_not_advertised']);
function requestError(message,url,status,metadata={}){
  const error=new Error(message);
  error.requestOutcome=url?.pathname.endsWith('/chat/completions')&&(status===undefined||status>=500)?'unknown':'not_dispatched';
  // Runtime reconnect policies consume httpStatus as an HTTP failure. Successful
  // headers prove a responder even when the body fails, but are not a rejection.
  if(Number.isInteger(status)&&status>=300&&status<=599)error.httpStatus=status;
  else if(Number.isInteger(status)&&status>=200&&status<300)error.observedHttpStatus=status;
  if(url)error.requestOperation=url.pathname.endsWith('/chat/completions')?'inference':'model_discovery';
  if(diagnosticCategories.has(metadata.category))error.diagnosticCategory=metadata.category;
  if(providerErrorCodes.has(metadata.providerErrorCode))error.providerErrorCode=metadata.providerErrorCode;
  if(['unknown','not_dispatched'].includes(metadata.outcome))error.requestOutcome=metadata.outcome;
  const retryHint=providedRetryHint(metadata);
  if(retryHint)error.retryHint=retryHint;
  return error;
}

function reportedCode(bytes){
  try{
    const body=JSON.parse(Buffer.concat(bytes).toString('utf8'));
    if(!body||typeof body!=='object'||Array.isArray(body)||!body.error||typeof body.error!=='object'||Array.isArray(body.error))return;
    for(const field of ['code','type'])if(providerErrorCodes.has(body.error[field]))return body.error[field];
  }catch{}
}

/** Read optional HTTP error metadata without withholding the known status. */
export function readProviderErrorCode(response,signal){
  return new Promise(resolve=>{
    const chunks=[];let size=0,finished=false,timer;
    const finish=complete=>{
      if(finished)return;finished=true;
      clearTimeout(timer);signal?.removeEventListener('abort',abort);
      resolve(complete?reportedCode(chunks):undefined);
      response.destroy();
    };
    const abort=()=>finish(false);
    // Only a complete small JSON body can supply a code. Slow, disconnected or
    // oversized bodies fall back to the already observed HTTP status.
    timer=setTimeout(()=>finish(false),100);
    signal?.addEventListener('abort',abort,{once:true});
    response.on('data',chunk=>{size+=chunk.length;if(size>4096)finish(false);else chunks.push(chunk);});
    response.on('end',()=>finish(true));
    response.on('aborted',()=>finish(false));
    response.on('error',()=>finish(false));
    response.on('close',()=>finish(false));
    if(signal?.aborted)finish(false);
  });
}

export function connectionCategory(error){
  const code=error?.cause?.code??error?.code;
  if(['ECONNREFUSED','ENOTFOUND','EAI_AGAIN','ENETUNREACH','EHOSTUNREACH','EADDRNOTAVAIL'].includes(code))return 'address';
  if(['CERT_HAS_EXPIRED','CERT_NOT_YET_VALID','DEPTH_ZERO_SELF_SIGNED_CERT','SELF_SIGNED_CERT_IN_CHAIN','UNABLE_TO_VERIFY_LEAF_SIGNATURE','UNABLE_TO_GET_ISSUER_CERT','UNABLE_TO_GET_ISSUER_CERT_LOCALLY','ERR_TLS_CERT_ALTNAME_INVALID','ERR_TLS_CERT_SIGNATURE_ALGORITHM_UNSUPPORTED'].includes(code))return 'tls';
  return 'connection';
}

// Injected Fetch implementations receive the same strict error-body budget as
// the native HTTP path. Only complete, small JSON bodies can supply a code.
async function fetchReportedCode(response,signal){
  if(providerErrorCodes.has(response.providerErrorCode))return response.providerErrorCode;
  if(!response.body?.getReader)return;
  let reader;try{reader=response.body.getReader();}catch{return;}
  const chunks=[];
  let timer,abort,size=0;
  const stop=new Promise(resolve=>{
    timer=setTimeout(()=>resolve({done:true,stopped:true}),100);
    abort=()=>resolve({done:true,stopped:true});
    signal?.addEventListener('abort',abort,{once:true});
    if(signal?.aborted)abort();
  });
  try{
    while(true){
      const part=await Promise.race([reader.read(),stop]);
      if(part.stopped)return;
      if(part.done)return reportedCode(chunks);
      size+=part.value.byteLength;
      if(size>4096)return;
      chunks.push(Buffer.from(part.value));
    }
  }catch{}finally{
    clearTimeout(timer);signal?.removeEventListener('abort',abort);
    void reader.cancel().catch(()=>{});
  }
}

export function validModelId(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 200 &&
    value.trim() === value && !/[\x00-\x1f\x7f-\x9f]/u.test(value);
}

function decodeUrlBytes(url) {
  return url.replace(/%([a-f0-9]{2})/gi, (_encoded, hex) => String.fromCharCode(Number.parseInt(hex, 16)));
}

function requestWithoutHeaderDeadline(url, options, signal) {
  return new Promise((resolve, reject) => {
    let observedErrorResponse,observedStatus;
    const rejectResponse=error=>{
      if(observedStatus!==undefined)error.observedHttpStatus=observedStatus;
      reject(error);
    };
    const transport = url.protocol === 'https:' ? https : http;
    const request = transport.request(url, {
      method: options.method ?? 'GET',
      headers: options.headers,
      signal,
    }, response => {
      observedStatus=response.statusCode;
      response.on('error', rejectResponse);
      if (response.statusCode < 200 || response.statusCode >= 300) {
        const retryHint=responseRetryHint(response);
        observedErrorResponse=()=>response.destroy();
        response.removeListener('error',rejectResponse);
        readProviderErrorCode(response,signal).then(providerErrorCode=>resolve({ok:false,status:response.statusCode,providerErrorCode,retryHint}));
        return;
      }
      const chunks = [];
      let size = 0;
      response.on('data', chunk => {
        size += chunk.length;
        if (size > 32 * 1024 * 1024) {
          request.destroy(new Error('DeepSeek response exceeded 32 MiB'));
          return;
        }
        chunks.push(chunk);
      });
      response.on('end', () => resolve({
        ok: true,
        status: response.statusCode,
        json: async () => JSON.parse(Buffer.concat(chunks).toString('utf8')),
      }));
      response.on('aborted', () => rejectResponse(new Error('Provider response disconnected')));
    });
    request.on('error',error=>observedErrorResponse?observedErrorResponse():rejectResponse(error));
    request.end(options.body);
  });
}

export class DeepSeekHttpAdapter {
  #jsonApiKey;

  constructor({ baseUrl, model, timeoutMs = 600_000, apiKey, openAICompatible = false, fetchImpl = requestWithoutHeaderDeadline } = {}) {
    if (!baseUrl) throw requestError(openAICompatible?'Configure an API worker base URL':'DEEPSEEK_BASE_URL is required (include /v1)');
    this.label=openAICompatible?'API worker':'DeepSeek';
    this.openAICompatible=openAICompatible;
    if(apiKey!==undefined&&(typeof apiKey!=='string'||!apiKey||apiKey.length>2048||/[^\x21-\x7e]/.test(apiKey)))throw requestError('Invalid API worker bearer key');
    this.apiKey = apiKey;
    this.#jsonApiKey = apiKey ? JSON.stringify(apiKey).slice(1, -1) : undefined;
    const base = endpoint(baseUrl, openAICompatible);
    if (apiKey && (typeof model === 'string' && this.containsCredential(model) ||
        this.containsCredential(baseUrl) || this.containsCredential(decodeUrlBytes(baseUrl)) ||
        this.containsCredential(decodeUrlBytes(base.href)))) {
      throw requestError('The bearer key must appear only in the credential field');
    }
    this.authHeaders=apiKey?{authorization:'Bearer '+apiKey}:{};
    this.modelsUrl = new URL('models', base);
    this.chatUrl = new URL('chat/completions', base);
    this.model = model || null;
    this.timeoutMs = timeoutMs;
    this.fetchImpl = fetchImpl;
    this.identity = model ? `deepseek-http/${model}` : 'deepseek-http/unresolved';
  }

  containsCredential(text) {
    if(!this.apiKey)return false;
    // Model identities are untrusted. Decode common wire spellings before
    // checking so encoded credentials cannot become public identity metadata.
    let decoded=text;
    for(let round=0;round<3;round++){
      if(decoded.includes(this.apiKey)||decoded.includes(this.#jsonApiKey))return true;
      const next=decodeUrlBytes(decoded).replace(/\\u([a-f0-9]{4})/gi,(_match,hex)=>String.fromCharCode(Number.parseInt(hex,16)))
        .replace(/\\(["\\/])/g,'$1');
      if(next===decoded)break;
      decoded=next;
    }
    return decoded.includes(this.apiKey)||decoded.includes(this.#jsonApiKey);
  }

  redact(text) {
    if (!this.apiKey) return text;
    // The coordinator also embeds JSON inside message strings.
    if (this.#jsonApiKey !== this.apiKey) text = text.replaceAll(this.#jsonApiKey, '[redacted]');
    return text.replaceAll(this.apiKey, '[redacted]');
  }

  redactData(value) {
    if (!this.apiKey || value === null) return value;
    if (typeof value === 'string') return this.redact(value);
    if (Array.isArray(value)) return value.map(item => this.redactData(item));
    if (typeof value === 'object') {
      return Object.fromEntries(Object.entries(value).map(([key, item]) => [this.redact(key), this.redactData(item)]));
    }
    return value;
  }

  async request(url, options, signal) {
    const timeout = AbortSignal.timeout(this.timeoutMs);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    let response;
    try {
      response = await this.fetchImpl(url, { ...options, redirect: 'manual', headers:{...options.headers,...this.authHeaders}, signal: combined }, combined);
    } catch (error) {
      const observed=error?.httpStatus??error?.observedHttpStatus;
      const status=Number.isInteger(observed)&&observed>=200&&observed<=599?observed:undefined;
      const outcome=url.pathname.endsWith('/chat/completions')?'unknown':'not_dispatched';
      if (signal?.aborted) throw requestError(this.label+' call interrupted',url,status,{category:'cancelled',outcome});
      if (timeout.aborted) throw requestError(`${this.label} call timed out after ${this.timeoutMs} ms`,url,status,{category:'timeout',outcome});
      const detail = this.apiKey?'connection error':(error.cause?.code ?? error.message);
      throw requestError(`${this.label} connection failed: ${detail}`,url,status,{category:connectionCategory(error),outcome});
    }
    if (!response.ok) {
      const retryHint=providedRetryHint(response)??responseRetryHint(response);
      const providerErrorCode=await fetchReportedCode(response,combined);
      throw requestError(`${this.label} ${this.redact(url.pathname)} returned HTTP ${response.status}`,url,response.status,{providerErrorCode,retryHint});
    }
    try {
      return await response.json();
    } catch {
      if (signal?.aborted) throw requestError(this.label+' call interrupted',url,response.status,{category:'cancelled',outcome:url.pathname.endsWith('/chat/completions')?'unknown':'not_dispatched'});
      if (timeout.aborted) throw requestError(`${this.label} call timed out after ${this.timeoutMs} ms`,url,response.status,{category:'timeout',outcome:url.pathname.endsWith('/chat/completions')?'unknown':'not_dispatched'});
      throw requestError(`${this.label} ${this.redact(url.pathname)} returned invalid JSON`,url,response.status,{category:'protocol',outcome:url.pathname.endsWith('/chat/completions')?'unknown':'not_dispatched'});
    }
  }

  async listModels(signal, { strict = false } = {}) {
    const body = await this.request(this.modelsUrl, { method: 'GET' }, signal);
    if (!Array.isArray(body?.data)) throw requestError(this.label+' /models returned no model list',this.modelsUrl,undefined,{category:'protocol'});
    const listed = body.data.map(item => item?.id);
    if (strict && !listed.every(validModelId)) throw requestError(this.label+' /models returned invalid model IDs',this.modelsUrl,undefined,{category:'protocol'});
    const ids = listed.filter(id =>
      (this.openAICompatible || strict ? validModelId(id) : typeof id === 'string' && id.trim()) &&
      !this.containsCredential(id));
    if (ids.length === 0) throw requestError(this.label+' /models returned no model IDs',this.modelsUrl,undefined,{category:'protocol'});
    return this.openAICompatible?[...new Set(ids)]:ids;
  }

  async resolveModel(signal) {
    if (this.resolvedModel) return this.resolvedModel;
    if(this.openAICompatible&&this.model)return this.resolvedModel=this.model;
    const ids=await this.listModels(signal);
    if (this.model && !ids.includes(this.model)) throw new Error(`Configured DeepSeek model ${this.model} is not advertised by /models`);
    if (!this.model && ids.length !== 1) throw new Error(this.openAICompatible?'Select a model advertised by /models':'DeepSeek /models advertised multiple models; set DEEPSEEK_MODEL_ID');
    this.resolvedModel = this.model ?? ids[0];
    this.identity = `deepseek-http/${this.resolvedModel}`;
    return this.resolvedModel;
  }

  async execute({ step, attempt, feedback, priorResult, signal }) {
    const model = await this.resolveModel(signal);
    const assignment = {
      objective: step.objective,
      context: step.context,
      expectedResult: step.expectedResult,
      attempt,
      ...(attempt > 1 ? { previousAnswer: priorResult?.answer, revisionFeedback: feedback } : {}),
    };
    const body = await this.request(this.chatUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model,
        stream: false,
        messages: [
          { role: 'system', content: 'Complete the project-design assignment as text. Do not request or claim tool use, file edits, or shell execution. Address revision feedback directly if provided.' },
          { role: 'user', content: JSON.stringify(this.redactData(assignment)) },
        ],
      }),
    }, signal);
    const choice = body?.choices?.[0];
    const answer = choice?.message?.content;
    if (typeof answer !== 'string' || !answer.trim()) throw new Error('DeepSeek returned an empty or unsupported answer');
    const result = {
      status: choice.finish_reason === 'length' ? 'failed' : 'completed',
      answer: this.redact(answer),
      model: this.redactData(body.model ?? model),
      finishReason: this.redactData(choice.finish_reason ?? null),
      ...(body.usage ? { usage: this.redactData(body.usage) } : {}),
    };
    if (result.status === 'failed') result.summary = 'DeepSeek answer was truncated';
    return result;
  }
}
