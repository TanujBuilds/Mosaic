import path from 'node:path';
import {spawn,spawnSync} from 'node:child_process';
import {lstat} from 'node:fs/promises';
import {windowsSystemTool} from '../harness/windows-desktop.mjs';
import {windowsFile} from './windows-files.mjs';

const unsafe = code => Object.assign(Error(code), {supportCode:code});

// Validate the user profile and every private directory below the installation
// root. The native helper also pins and checks the containing path on each open.
export async function supportDirectory(directory, {home,privateRoot} = {}) {
  if (!privateRoot) {
    if (await windowsFile('directory',directory,{optional:true}) === null) return false;
    if (directory===home) await companion('owner',directory);
    return true;
  }
  const relative = path.relative(privateRoot,directory);
  if (path.isAbsolute(relative) || relative === '..' || relative.startsWith('..'+path.sep)) throw unsafe('LOCAL_FILE_UNSAFE');
  let current = privateRoot;
  for (const part of ['', ...relative.split(path.sep).filter(Boolean)]) {
    if (part) current = path.join(current,part);
    if (await windowsFile('private-directory',current,{optional:true}) === null) return false;
  }
  return true;
}

export async function supportMetadata(file,max) {
  let bytes;
  try {bytes = await windowsFile('read-private',file,{max,optional:true});}
  catch (error) {
    throw unsafe(error.message.includes('File exceeds read limit') ? 'LOCAL_FILE_TOO_LARGE' : 'LOCAL_FILE_UNSAFE');
  }
  if (bytes === null) return null;
  let value;
  try {value = JSON.parse(bytes);} catch {throw unsafe('LOCAL_JSON_INVALID');}
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw unsafe('LOCAL_JSON_INVALID');
  return value;
}

export async function supportViewerFile(file,max) {
  if (await windowsFile('private-file',file,{optional:true})===null) return false;
  // The viewer client revalidates the private handle and the byte bound when
  // it actually reads the token. This preflight never receives those bytes.
  if ((await lstat(file)).size>max) throw unsafe('LOCAL_FILE_TOO_LARGE');
  return true;
}

// Windows PowerShell ships with .NET Framework. The fixed program goes on the
// command line; only stdin carries the path and optional redacted report.
const script = String.raw`
$ErrorActionPreference = 'Stop'
try {
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Text;
using Microsoft.Win32.SafeHandles;

public static class MosaicSupport {
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
    static extern SafeFileHandle CreateFileW(string path, uint access, uint share,
        IntPtr security, uint disposition, uint flags, IntPtr template);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode)]
    static extern uint GetDriveTypeW(string root);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
    static extern uint GetLongPathNameW(string path, StringBuilder buffer, uint size);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
    static extern uint GetFinalPathNameByHandleW(SafeFileHandle h, StringBuilder buffer, uint size, uint flags);
    [DllImport("kernel32.dll", SetLastError=true)]
    static extern bool SetFileInformationByHandle(SafeFileHandle h, int kind, byte[] data, uint size);

    static void Check(bool ok) { if (!ok) throw new IOException(); }

    // Open every ancestor before evaluating the ACL or using its pathname.
    // No handle shares write/delete access to the directory it denotes.
    static void Pin(string folder, List<SafeFileHandle> pins) {
        var handle = CreateFileW(folder, 0x80, 1, IntPtr.Zero, 3, 0x02200000, IntPtr.Zero);
        pins.Add(handle);
        Check(!handle.IsInvalid);
        var kind = File.GetAttributes(folder);
        Check((kind & FileAttributes.Directory) != 0 && (kind & FileAttributes.ReparsePoint) == 0);
        var actual = new StringBuilder(32768);
        uint n = GetFinalPathNameByHandleW(handle, actual, (uint)actual.Capacity, 0);
        var expected = new StringBuilder(32768);
        uint length = GetLongPathNameW(folder,expected,(uint)expected.Capacity);
        Check(length > 0 && length < expected.Capacity && n > 0 && n < actual.Capacity &&
            String.Equals(actual.ToString(), @"\\?\" + expected.ToString(), StringComparison.OrdinalIgnoreCase));
    }
    static void CheckOwner(string dir, SecurityIdentifier user, bool requirePrivate) {
        var acl = Directory.GetAccessControl(dir, AccessControlSections.Owner | AccessControlSections.Access);
        Check(user.Equals(acl.GetOwner(typeof(SecurityIdentifier))));
        if (!requirePrivate) return;
        var descriptor = new RawSecurityDescriptor(acl.GetSecurityDescriptorBinaryForm(), 0);
        Check(descriptor.DiscretionaryAcl != null);
        foreach (GenericAce ace in descriptor.DiscretionaryAcl) {
            if (ace.AceType == AceType.AccessDenied) continue;
            Check(ace.AceType == AceType.AccessAllowed);
            var sid = ((CommonAce)ace).SecurityIdentifier;
            Check(sid.Equals(user) || sid.IsWellKnown(WellKnownSidType.LocalSystemSid) ||
                sid.IsWellKnown(WellKnownSidType.BuiltinAdministratorsSid));
        }
    }
    static bool SafeName(string name) {
        if (name.Length == 0 || name.EndsWith(".") || name.EndsWith(" ") ||
            name.IndexOfAny(Path.GetInvalidFileNameChars()) >= 0) return false;
        string stem = name.Split('.')[0].TrimEnd(' ').ToUpperInvariant();
        return !System.Text.RegularExpressions.Regex.IsMatch(stem, @"^(CON(IN\$|OUT\$)?|PRN|NUL|AUX|COM[0-9¹²³]|LPT[0-9¹²³])$");
    }
    public static string Stage = "path";
    public static int Run(string operation, string file, byte[] data) {
        Check(operation == "owner" || operation == "export");
        Check(file.Length >= 3 && file[1] == ':' && file[2] == '\\' &&
            ((file[0] >= 'A' && file[0] <= 'Z') || (file[0] >= 'a' && file[0] <= 'z')));
        string root = Path.GetPathRoot(file);
        Check(root.Length == 3 && GetDriveTypeW(root) == 3);
        var parts = file.Substring(3).Split('\\');
        foreach (string part in parts) Check(SafeName(part));
        bool exporting = operation == "export";
        int count = exporting ? parts.Length - 1 : parts.Length;
        var pins = new List<SafeFileHandle>();
        try {
            string dir = root;
            Stage = "ancestor";
            Pin(dir, pins);
            for (int i=0; i<count; i++) {
                dir = Path.Combine(dir, parts[i]);
                Pin(dir, pins);
            }
            var user = WindowsIdentity.GetCurrent().User;
            Stage = "owner";
            CheckOwner(dir, user, exporting);
            if (!exporting) return 0;
            Stage = "create";
            Check(data.Length <= 256*1024);
            var security = new FileSecurity();
            security.SetOwner(user);
            security.SetAccessRuleProtection(true,false);
            foreach (var sid in new[] {user, new SecurityIdentifier(WellKnownSidType.LocalSystemSid,null),
                    new SecurityIdentifier(WellKnownSidType.BuiltinAdministratorsSid,null)})
                security.AddAccessRule(new FileSystemAccessRule(sid, FileSystemRights.FullControl, AccessControlType.Allow));
            string tmp = Path.Combine(dir, ".mosaic-support-" + Guid.NewGuid().ToString("N"));
            using (var stream = new FileStream(tmp, FileMode.CreateNew, FileSystemRights.Write | FileSystemRights.Delete,
                    FileShare.None, 4096, FileOptions.WriteThrough, security)) {
                bool published = false;
                try {
                    stream.Write(data,0,data.Length);
                    stream.Flush(true);
                    // FILE_RENAME_INFO uses a zero ReplaceIfExists and null RootDirectory.
                    // The rename is issued on the same open file whose bytes were flushed.
                    Stage = "publish";
                    byte[] name = Encoding.Unicode.GetBytes(file);
                    int lengthAt = IntPtr.Size * 2;
                    byte[] rename = new byte[lengthAt + 4 + name.Length + IntPtr.Size];
                    Array.Copy(BitConverter.GetBytes(name.Length),0,rename,lengthAt,4);
                    Array.Copy(name,0,rename,lengthAt+4,name.Length);
                    if (!SetFileInformationByHandle(stream.SafeFileHandle, 3, rename, (uint)rename.Length)) {
                        int code = Marshal.GetLastWin32Error();
                        if (code == 80 || code == 183) return 3;
                        throw new IOException();
                    }
                    published = true;
                    return 0;
                } finally {
                    if (!published) Check(SetFileInformationByHandle(stream.SafeFileHandle, 4, new byte[]{1,0,0,0}, 4));
                }
            }
        } finally {
            for (int i=pins.Count-1; i>=0; i--) pins[i].Dispose();
        }
    }
}
'@
$request = [Console]::In.ReadToEnd() | ConvertFrom-Json
$path = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($request.path))
$bytes = [Convert]::FromBase64String([string]$request.data)
exit ([MosaicSupport]::Run([string]$request.operation,$path,$bytes))
} catch {if('MosaicSupport' -as [type]){[Console]::Error.Write([MosaicSupport]::Stage)};exit 1}
`;
const args = ['-NoLogo','-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')];
function request(operation,file,bytes) {
  return JSON.stringify({operation,path:Buffer.from(file).toString('base64'),data:Buffer.from(bytes).toString('base64')});
}
export function createPrivateFileSync(file,bytes) {
  const shell=windowsSystemTool('WindowsPowerShell','v1.0','powershell.exe');
  const result=spawnSync(shell,args,{input:request('export',file,bytes),stdio:['pipe','ignore','pipe'],windowsHide:true,timeout:8000});
  if(result.status===3)throw Object.assign(Error('Private file already exists'),{code:'EEXIST'});
  if(result.error||result.status!==0){
    const stage=result.stderr?.toString();
    throw Error('Cannot create a private Windows file'+(['path','ancestor','owner','create','publish'].includes(stage)?' ('+stage+')':''));
  }
}
function companion(operation,file,bytes='') {
  const shell=windowsSystemTool('WindowsPowerShell','v1.0','powershell.exe');
  return new Promise((resolve,reject)=>{
    const child=spawn(shell,args,{windowsHide:true,stdio:['pipe','ignore','ignore'],timeout:8000});
    const onFailure=()=>reject(unsafe('OUTPUT_UNSAFE'));
    child.on('error',onFailure);
    child.stdin.on('error',onFailure);
    child.on('close',code=>code===0?resolve():reject(unsafe(code===3?'OUTPUT_EXISTS':'OUTPUT_UNSAFE')));
    child.stdin.end(request(operation,file,bytes));
  });
}
export async function writeSupportBundle(file,bytes) {
  return companion('export',file,bytes);
}
