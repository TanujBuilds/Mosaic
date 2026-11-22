import assert from 'node:assert/strict';
import {execFile, spawn} from 'node:child_process';
import {createHash, randomBytes, randomUUID} from 'node:crypto';
import {once} from 'node:events';
import {createReadStream} from 'node:fs';
import {lstat, mkdtemp, readFile, readdir, rm} from 'node:fs/promises';
import {createServer} from 'node:https';
import path from 'node:path';
import {createInterface} from 'node:readline';
import {pipeline} from 'node:stream/promises';
import {promisify} from 'node:util';
import {makeInstallCommand} from '../../scripts/package-windows-beta.mjs';

assert.equal(process.platform,'win32');
assert.equal(process.arch,'x64');
assert.equal(process.env.GITHUB_ACTIONS,'true','Use a disposable Windows runner account');
assert.equal(process.argv.length,3,'Provide the directory containing candidate.json');
const directory=path.resolve(process.argv[2]);
const candidate=JSON.parse(await readFile(path.join(directory,'candidate.json'),'utf8'));
assert.equal(candidate.kind,'mosaic-windows-beta-candidate');
assert.match(candidate.version,/^\d+\.\d+\.\d+-beta\.\d+$/);
assert.equal(candidate.archiveName,'mosaic-beta-'+candidate.version+'-win-x64.zip');
const archive=path.join(directory,candidate.archiveName),bootstrap=path.join(directory,'install.ps1');
async function hash(file,options) {
  const sha=createHash('sha256');
  for await (const chunk of createReadStream(file,options)) sha.update(chunk);
  return sha.digest('hex');
}
assert.equal(await hash(bootstrap),candidate.bootstrapSha256);
assert.equal(await hash(archive),candidate.archiveSha256);
const size=(await lstat(archive)).size;
const cut=1024*1024;
assert.ok(size>cut);
const root=path.join(process.env.LOCALAPPDATA,'Mosaic Beta');
const installed=path.join(root,'versions',candidate.version);
const pointer=path.join(root,'current-version.txt'),launcher=path.join(root,'bin','mosaic.exe');
const receiptPath=path.join(root,'config','installation.json');
const absent=file=>assert.rejects(lstat(file),{code:'ENOENT'});
await absent(root);
const scratch=await mkdtemp(path.join(process.env.RUNNER_TEMP,'Mosaic HTTPS '));
const shell=path.join(process.env.SystemRoot,'System32','WindowsPowerShell','v1.0','powershell.exe');
const exec=promisify(execFile);
const psArgs=source=>['-NoLogo','-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(source,'utf16le').toString('base64')];
const env=Object.fromEntries(Object.entries(process.env).filter(([key])=>
  !/^(?:no_proxy|https?_proxy|all_proxy|curl_ca_bundle|ssl_cert_file|ssl_cert_dir|node_options|node_path|psmodulepath)$/i.test(key)));
env.NO_PROXY='127.0.0.1';
const options={cwd:scratch,env,windowsHide:true,timeout:240000,maxBuffer:2*1024*1024};
const passphrase=randomBytes(32).toString('hex');
const certId=randomUUID();
// The trust owner waits on an anonymous pipe. Normal exit and loss of the Node
// parent both close stdin and remove the exact certificate and its private key.
const certModule=String.raw`
$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
Import-Module (Join-Path $PSHOME 'Modules\Microsoft.PowerShell.Security\Microsoft.PowerShell.Security.psd1') -ErrorAction Stop
$null=Get-PSDrive -Name Cert -ErrorAction Stop
`;
const certScript=certModule+String.raw`
$cert=$null
$store=[Security.Cryptography.X509Certificates.X509Store]::new('Root','CurrentUser')
try {
  $params=@{
    Subject=("CN=Mosaic fixture "+$env:MOSAIC_CERT_ID); Type='Custom'
    CertStoreLocation='Cert:\CurrentUser\My'; KeyExportPolicy='Exportable'
    KeyAlgorithm='RSA'; KeyLength=2048; HashAlgorithm='SHA256'
    NotBefore=(Get-Date).AddMinutes(-5); NotAfter=(Get-Date).AddHours(1)
    TextExtension=@('2.5.29.17={text}IPAddress=127.0.0.1','2.5.29.37={text}1.3.6.1.5.5.7.3.1','2.5.29.19={critical}{text}ca=0')
  }
  $cert=New-SelfSignedCertificate @params
  [Console]::WriteLine('CREATED '+$cert.Thumbprint)
  [Console]::Out.Flush()
  $password=ConvertTo-SecureString $env:MOSAIC_PFX_PASSWORD -AsPlainText -Force
  Export-PfxCertificate -Cert $cert -FilePath 'fixture.pfx' -Password $password -CryptoAlgorithmOption AES256_SHA256 -ChainOption EndEntityCertOnly | Out-Null
  $store.Open('ReadWrite')
  if($store.Certificates.Find('FindByThumbprint',$cert.Thumbprint,$false).Count){throw 'Certificate collision'}
  $public=[Security.Cryptography.X509Certificates.X509Certificate2]::new($cert.RawData)
  $store.Add($public)
  [Console]::WriteLine($cert.Thumbprint)
  [Console]::Out.Flush()
  $null=[Console]::In.ReadToEnd()
} finally {
  if($cert) {
    try {
      foreach($item in $store.Certificates.Find('FindByThumbprint',$cert.Thumbprint,$false)){$store.Remove($item)}
      if($store.Certificates.Find('FindByThumbprint',$cert.Thumbprint,$false).Count){throw 'Trust removal failed'}
    } finally {Remove-Item -LiteralPath ('Cert:\CurrentUser\My\'+$cert.Thumbprint) -DeleteKey -Force}
  }
  $store.Close()
}`;
const owner=spawn(shell,psArgs(certScript),{
  cwd:scratch,env:{...env,MOSAIC_CERT_ID:certId,MOSAIC_PFX_PASSWORD:passphrase},
  windowsHide:true,stdio:['pipe','pipe','pipe'],
});
const ownerClosed=once(owner,'close');
const lines=createInterface({input:owner.stdout});
let certErrors='';
owner.stderr.setEncoding('utf8').on('data',chunk=>{certErrors=(certErrors+chunk).slice(-4096);});
let server,certReadyTimer,createdCert;
const ready=new Promise(resolve=>lines.on('line',line=>{
  const created=/^CREATED ([0-9A-F]{40})$/i.exec(line.trim());
  if(created)createdCert=created[1];
  else if(createdCert && line.trim()===createdCert)resolve(createdCert);
}));
try {
  const thumbprint=await Promise.race([
    ready,
    ownerClosed.then(()=>{throw Error('Fixture certificate setup failed: '+certErrors);}),
    new Promise((_,reject)=>{certReadyTimer=setTimeout(()=>reject(Error('Fixture certificate setup timed out')),35000);}),
  ]);
  assert.match(thumbprint,/^[0-9A-F]{40}$/i);
  const requests=[];
  let interrupted=false;
  const serverErrors=[];
  server=createServer({pfx:await readFile(path.join(scratch,'fixture.pfx')),passphrase,minVersion:'TLSv1.2'},(req,res)=>{
    async function serve() {
      assert.equal(req.method,'GET');
      assert.equal(req.headers.authorization,undefined);
      const range=req.headers.range??null;
      requests.push([req.url,range]);
      if (req.url==='/install.ps1' && !range) {
        res.writeHead(200,{'Content-Length':(await lstat(bootstrap)).size});
        return pipeline(createReadStream(bootstrap),res);
      }
      assert.equal(req.url,'/'+candidate.archiveName);
      if (!interrupted) {
        assert.equal(range,null);
        interrupted=true;
        // Advertise the real length and close the transfer after the prefix.
        // Stock curl detects the short body and leaves its own partial file.
        res.writeHead(200,{'Accept-Ranges':'bytes','Content-Length':size,'Connection':'close'});
        return pipeline(createReadStream(archive,{start:0,end:cut-1}),res);
      }
      assert.equal(range,'bytes='+cut+'-','Retry must resume the interrupted file');
      res.writeHead(206,{'Accept-Ranges':'bytes','Content-Range':`bytes ${cut}-${size-1}/${size}`,'Content-Length':size-cut});
      return pipeline(createReadStream(archive,{start:cut}),res);
    }
    serve().catch(error=>{serverErrors.push(error);res.destroy();});
  });
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  const origin='https://127.0.0.1:'+server.address().port;
  const command=makeInstallCommand(candidate,{bootstrapUri:origin+'/install.ps1',archiveUri:origin+'/'+candidate.archiveName});
  const run=()=>exec(shell,psArgs(command),options);
  await assert.rejects(run(),error=>{
    assert.equal(error.code,1,error.stderr);
    assert.match(error.stderr,/Mosaic download interrupted/i);
    return true;
  });
  const partial=path.join(root,'downloads',candidate.archiveSha256+'.part');
  assert.equal((await lstat(partial)).size,cut);
  assert.equal(await hash(partial),await hash(archive,{start:0,end:cut-1}));
  await Promise.all([pointer,launcher,receiptPath,installed].map(absent));

  // Redirected CI cannot enter the interactive guide. This is its documented
  // post-install prompt and is distinct from a failed archive or install.
  await assert.rejects(run(),error=>{
    assert.equal(error.code,1,error.stderr);
    assert.match(error.stdout,/installed for this user/);
    assert.match(error.stderr,/Open PowerShell to continue setup/);
    return true;
  });
  assert.deepEqual(serverErrors,[]);
  assert.deepEqual(requests,[['/install.ps1',null],['/'+candidate.archiveName,null],['/install.ps1',null],['/'+candidate.archiveName,'bytes='+cut+'-']]);
  assert.equal(await readFile(pointer,'utf8'),candidate.version+'\n');
  const receipt=JSON.parse(await readFile(receiptPath,'utf8'));
  assert.equal(receipt.version,candidate.version);
  assert.equal(receipt.archiveSha256,candidate.archiveSha256);
  const manifestPath=path.join(installed,'package-manifest.json');
  assert.equal(await hash(manifestPath),candidate.packageManifestSha256);
  assert.equal(receipt.manifestSha256,candidate.packageManifestSha256);
  const manifest=JSON.parse(await readFile(manifestPath,'utf8'));
  assert.equal(manifest.contentHash,receipt.contentHash);
  const actual=[];
  for(const item of await readdir(installed,{recursive:true,withFileTypes:true})) {
    if(item.isDirectory())continue;
    assert.ok(item.isFile());
    actual.push(path.relative(installed,path.join(item.parentPath,item.name)).split(path.sep).join('/'));
  }
  assert.deepEqual(actual.sort(),['package-manifest.json',...manifest.files.map(item=>item.path)].sort());
  for(const item of manifest.files) {
    const file=path.join(installed,item.path);
    assert.equal((await lstat(file)).size,item.bytes,item.path);
    assert.equal(await hash(file),item.sha256,item.path);
  }
  assert.equal(await hash(launcher),receipt.launcherHash);
  assert.match((await exec(launcher,['--help'],options)).stdout,/Mosaic Beta/);
  console.log('Stock Windows PowerShell resumed the verified HTTPS archive at byte',cut,'and validated',manifest.files.length,'installed files and the launcher. Interactive setup awaits an attached console.');
} finally {
  clearTimeout(certReadyTimer);
  lines.close();
  if(server){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
  owner.stdin.end();
  const watchdog=setTimeout(()=>owner.kill('SIGKILL'),20000);
  try {
    const [code]=await ownerClosed;
    // Verify independently of the owner. Also reclaim the exact certificate if the owner stalled.
    if(createdCert){
      const cleanup=certModule+String.raw`
foreach($store in @('Root','My')){
 $file="Cert:\CurrentUser\$store\$env:MOSAIC_CERT_HASH"
 $cert=Get-Item -LiteralPath $file -ErrorAction SilentlyContinue
 if($cert){
  if($cert.Subject -ne ('CN=Mosaic fixture '+$env:MOSAIC_CERT_ID)){throw 'Certificate ownership mismatch'}
  if($store -eq 'My'){Remove-Item -LiteralPath $file -DeleteKey -Force}else{Remove-Item -LiteralPath $file -Force}
 }
 if(Test-Path -LiteralPath $file){throw 'Certificate cleanup incomplete'}
}`;
      await exec(shell,psArgs(cleanup),{...options,timeout:30000,env:{...env,MOSAIC_CERT_HASH:createdCert,MOSAIC_CERT_ID:certId}});
    }
    assert.equal(code,0,'Fixture certificate cleanup or setup failed: '+certErrors);
  } finally {clearTimeout(watchdog);await rm(scratch,{recursive:true,force:true,maxRetries:5});}
}
