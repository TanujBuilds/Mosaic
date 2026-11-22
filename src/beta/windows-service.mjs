import {execFile} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {promisify} from 'node:util';
import path from 'node:path';
import {hash,jsonFile,saveJson} from './files.mjs';

const exec=promisify(execFile);
const taskProgram=String.raw`
$ErrorActionPreference = 'Stop'
$sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$name = "Mosaic Beta " + $sid + " " + $env:MOSAIC_TASK_SUFFIX
$service = New-Object -ComObject Schedule.Service
$service.Connect()
$folder = $service.GetFolder('\')
$task = @($folder.GetTasks(1) | Where-Object Name -eq $name) | Select-Object -First 1
function Fingerprint($value) {
  $sha = [Security.Cryptography.SHA256]::Create()
  try { return [BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($value.Xml))).Replace('-','').ToLowerInvariant() }
  finally { $sha.Dispose() }
}
if ($env:MOSAIC_TASK_OPERATION -eq 'query') {
  if ($task) { [Console]::Write((Fingerprint $task)) }
  exit 0
}
if ($env:MOSAIC_TASK_OPERATION -eq 'adopt') {
  if (!$task) { exit 0 }
  $d = $task.Definition
  if ($d.RegistrationInfo.Description -ne $env:MOSAIC_TASK_DESCRIPTION -or
      $d.Actions.Count -ne 1 -or $d.Actions.Item(1).Type -ne 0 -or
      $d.Actions.Item(1).Path -cne $env:MOSAIC_TASK_LAUNCHER -or
      $d.Actions.Item(1).Arguments -cne 'serve' -or $d.Actions.Item(1).WorkingDirectory -cne $env:MOSAIC_TASK_STATE -or
      $d.Triggers.Count -ne 1 -or $d.Triggers.Item(1).Type -ne 9 -or
      $d.Principal.LogonType -ne 3 -or $d.Principal.RunLevel -ne 0) { throw 'Interrupted registration differs from its saved intent.' }
  [Console]::Write((Fingerprint $task))
  exit 0
}
if ($env:MOSAIC_TASK_OPERATION -eq 'create') {
  if ($task) { throw 'The scheduled task name is already registered.' }
  $def = $service.NewTask(0)
  $def.RegistrationInfo.Description = $env:MOSAIC_TASK_DESCRIPTION
  $def.Principal.UserId = $sid
  $def.Principal.LogonType = 3
  $def.Principal.RunLevel = 0
  $def.Settings.MultipleInstances = 2
  $def.Settings.DisallowStartIfOnBatteries = $false
  $def.Settings.StopIfGoingOnBatteries = $false
  $def.Settings.ExecutionTimeLimit = 'PT0S'
  $def.Settings.StartWhenAvailable = $true
  $def.Settings.RestartCount = 3
  $def.Settings.RestartInterval = 'PT1M'
  $trigger = $def.Triggers.Create(9)
  $trigger.UserId = $sid
  $action = $def.Actions.Create(0)
  $action.Path = $env:MOSAIC_TASK_LAUNCHER
  $action.Arguments = 'serve'
  $action.WorkingDirectory = $env:MOSAIC_TASK_STATE
  $task = $folder.RegisterTaskDefinition($name,$def,2,$sid,$null,3,$null)
  [Console]::Write((Fingerprint $task))
  exit 0
}
if (!$task -or (Fingerprint $task) -ne $env:MOSAIC_TASK_EXPECTED) { throw 'The scheduled task has changed.' }
switch ($env:MOSAIC_TASK_OPERATION) {
  'run' { $null = $task.Run($null) }
  'remove' { $folder.DeleteTask($name,0) }
  default { throw 'Unknown task operation.' }
}
`;
export const serviceRecord=paths=>path.join(paths.configDir,'windows-service.json');
export const serviceDefinition=paths=>JSON.stringify({version:1,launcher:paths.launcher,args:['serve'],state:paths.state});
async function scheduler(paths,op,expected='',nonce='') {
  const powershell=path.join(process.env.SystemRoot,'System32','WindowsPowerShell','v1.0','powershell.exe');
  const {stdout}=await exec(powershell,['-NoLogo','-NoProfile','-NonInteractive','-EncodedCommand',
    Buffer.from(taskProgram,'utf16le').toString('base64')],{windowsHide:true,timeout:20000,maxBuffer:16384,
    env:{...process.env,MOSAIC_TASK_SUFFIX:hash(paths.launcher.toLowerCase()).slice(0,16),MOSAIC_TASK_DESCRIPTION:'Mosaic Beta coordinator '+nonce,MOSAIC_TASK_OPERATION:op,MOSAIC_TASK_EXPECTED:expected,MOSAIC_TASK_LAUNCHER:paths.launcher,MOSAIC_TASK_STATE:paths.state}});
  return stdout.trim();
}
export async function registration(paths) {
  const record=await jsonFile(serviceRecord(paths),{privateFile:true,max:4096});
  if(record?.phase==='creating'){
    if(record.definition!==hash(serviceDefinition(paths)) || !/^[a-f0-9-]{36}$/.test(record.nonce))throw Error('Invalid Windows registration intent.');
    const recovered=await scheduler(paths,'adopt','',record.nonce);
    if(!recovered)return {owned:true,registered:false,xmlHash:'',nonce:record.nonce};
    if(!/^[a-f0-9]{64}$/.test(recovered))throw Error('Windows task recovery could not verify its definition.');
    await saveJson(serviceRecord(paths),{version:1,definition:record.definition,xmlHash:recovered});
    return {owned:true,registered:true,xmlHash:recovered};
  }
  const actual=await scheduler(paths,'query');
  if(record && (record.definition!==hash(serviceDefinition(paths)) || !/^[a-f0-9]{64}$/.test(record.xmlHash)))throw Error('Windows service registration record changed.');
  if(actual && actual!==record?.xmlHash)throw Error('An existing Windows scheduled task has a different registration. Preserve it and inspect Task Scheduler.');
  return {owned:!!record,registered:!!actual,xmlHash:actual};
}
export async function ensureWindowsService(paths) {
  let {registered,xmlHash,nonce}=await registration(paths);
  if(!registered){
    nonce??=randomUUID();
    await saveJson(serviceRecord(paths),{version:1,phase:'creating',definition:hash(serviceDefinition(paths)),nonce});
    xmlHash=await scheduler(paths,'create','',nonce);
    if(!/^[a-f0-9]{64}$/.test(xmlHash))throw Error('Windows service registration could not be verified.');
    await saveJson(serviceRecord(paths),{version:1,definition:hash(serviceDefinition(paths)),xmlHash});
  }
  return xmlHash;
}
export async function startWindowsService(paths) {
  const xmlHash=await ensureWindowsService(paths);
  await scheduler(paths,'run',xmlHash);
}
export async function unregisterWindowsService(paths) {
  const current=await registration(paths);
  if(current.registered)await scheduler(paths,'remove',current.xmlHash);
}
