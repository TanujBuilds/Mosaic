import {workerEndpoint} from '../harness/worker-profile.mjs';

export const hostedWorkerPresets=[
 {displayName:'OpenAI Platform',baseUrl:'https://api.openai.com/v1',account:'OpenAI Platform API key'},
 {displayName:'Kimi Platform',baseUrl:'https://api.moonshot.ai/v1',account:'Kimi Platform pay-as-you-go API key'},
 {displayName:'Z.ai GLM',baseUrl:'https://api.z.ai/api/paas/v4',account:'Z.ai general API key'},
 {displayName:'OpenRouter',baseUrl:'https://openrouter.ai/api/v1',account:'OpenRouter API key',modelExample:'moonshotai/kimi-k3.1-pro'},
];

export function hostedWorkerChoices(firstNumber){
 return hostedWorkerPresets.map(({displayName,account},index)=>`  ${firstNumber+index}. ${displayName} (${account})`).join('\n');
}

export async function askWorkerEndpoint(ask,output,prompt,{retry=false}={}){
 while(true){
  const input=await ask(prompt,{masked:true});
  try{workerEndpoint(input);return input;}
  catch(error){
   if(!retry)throw error;
   output.write(error.message+'\nEnter the server URL here. The key prompt comes later.\n');
  }
 }
}

export async function selectHostedWorkerEndpoint(ask,output,prompt,{choose,retry=false}={}){
 let input;
 if(choose){
  const options=hostedWorkerPresets.map(({displayName},index)=>({value:String(index+1),label:displayName}));
  options.push({value:String(options.length+1),label:'Custom API endpoint'});
  input=await choose('Choose a hosted provider',options,{stage:2});
  if(input===options.at(-1).value)return {baseUrl:await askWorkerEndpoint(ask,output,prompt,{retry:true}),preset:null};
 }else{
  output.write('Choose a hosted provider number or paste your own OpenAI-compatible API base URL.\n'+hostedWorkerChoices(1)+'\n');
  while(true){
   input=await ask(prompt,{masked:true});
   if(/^\d+$/.test(input))break;
   try{workerEndpoint(input);return {baseUrl:input,preset:null};}
   catch(error){
    if(!retry)throw error;
    output.write(error.message+'\nEnter the server URL here. The key prompt comes later.\n');
   }
  }
 }
 const preset=hostedWorkerPresets[Number(input)-1];
 if(!preset)throw Error('Invalid hosted API provider choice');
 return {baseUrl:preset.baseUrl,preset};
}

export async function readBearerKey(ask,prompt){
 const key=await ask(prompt,{secret:true});
 if(!key)throw Error('An API key cannot be empty.');
 return key;
}
