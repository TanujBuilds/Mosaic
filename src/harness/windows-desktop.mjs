import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';

const exec=promisify(execFile);
export const windowsSystemTool=(...parts)=>path.win32.join(process.env.SystemRoot??'C:\\Windows','System32',...parts);
const powershell=()=>windowsSystemTool('WindowsPowerShell','v1.0','powershell.exe');
const argumentsFor=script=>['-NoLogo','-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')];

export function preventWindowsSleep(spawnProcess,deadline){
  // The anonymous pipe closes when the coordinator exits. A bounded timer also
  // releases the assertion when the original approved deadline elapses.
  const script=`
$ErrorActionPreference = 'Stop'
Add-Type -Namespace Mosaic -Name Power -MemberDefinition '[System.Runtime.InteropServices.DllImport("kernel32.dll")] public static extern uint SetThreadExecutionState(uint flags);'
if (![Mosaic.Power]::SetThreadExecutionState(2147483649)) { exit 1 }
try {
  $inputStream = [Console]::OpenStandardInput()
  $read = $inputStream.ReadAsync((New-Object byte[] 1),0,1)
  $end = [DateTimeOffset]::FromUnixTimeMilliseconds([long]$env:MOSAIC_POWER_DEADLINE)
  while (!$read.IsCompleted) {
    $remaining = ($end - [DateTimeOffset]::UtcNow).TotalMilliseconds
    if ($remaining -le 0) { break }
    $null = $read.Wait([int][Math]::Min(60000,$remaining))
  }
} finally { $null=[Mosaic.Power]::SetThreadExecutionState(2147483648) }
`;
  return spawnProcess(powershell(),argumentsFor(script),{stdio:['pipe','ignore','ignore'],windowsHide:true,
    env:{...process.env,MOSAIC_POWER_DEADLINE:String(deadline)}});
}
export async function windowsAlert(message){
  const script=`
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$icon = New-Object Windows.Forms.NotifyIcon
try {
  $icon.Icon = [Drawing.SystemIcons]::Information
  $icon.Visible = $true
  $icon.ShowBalloonTip(2500,'Mosaic',$env:MOSAIC_NOTICE,[Windows.Forms.ToolTipIcon]::Info)
  Start-Sleep -Milliseconds 2700
} finally { $icon.Dispose() }
`;
  await exec(powershell(),argumentsFor(script),{timeout:10000,windowsHide:true,env:{...process.env,MOSAIC_NOTICE:message}});
  return {status:'submitted',visibility:'Windows controls presentation; see the saved morning report.'};
}
