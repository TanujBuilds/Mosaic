// Windows 11 x64. The coordinator alone owns stdin and receives the JSONL
// protocol on stdout. The check inherits only its own standard handles.
#ifndef _WIN32_WINNT
#define _WIN32_WINNT 0x0A00
#endif
#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>

#include <aclapi.h>
#include <algorithm>
#include <cstdio>
#include <cstring>
#include <filesystem>
#include <memory>
#include <sddl.h>
#include <stdexcept>
#include <string>
#include <userenv.h>
#include <vector>

namespace fs = std::filesystem;
using std::string;
using std::wstring;

static void require(bool ok, const char *operation) {
  if (!ok)
    throw std::runtime_error(string(operation) + " (Windows error " +
                             std::to_string(GetLastError()) + ")");
}
struct Handle {
  HANDLE h = nullptr;
  explicit Handle(HANDLE value = nullptr) : h(value) {}
  Handle(const Handle &) = delete;
  Handle &operator=(const Handle &) = delete;
  ~Handle() { reset(); }
  void reset() {
    if (h && h != INVALID_HANDLE_VALUE)
      CloseHandle(h);
    h = nullptr;
  }
};
struct Local {
  HLOCAL data = nullptr;
  ~Local() {
    if (data)
      LocalFree(data);
  }
};
static void writeAll(HANDLE h, const string &data) {
  size_t pos = 0;
  while (pos < data.size()) {
    DWORD done = 0;
    require(WriteFile(h, data.data() + pos,
                      static_cast<DWORD>(data.size() - pos), &done, nullptr) &&
                done,
            "WriteFile");
    pos += done;
  }
}
static bool channelClosed = false;
static void emit(const string &line) {
  if (channelClosed)
    return;
  try {
    writeAll(GetStdHandle(STD_OUTPUT_HANDLE), line + "\n");
  } catch (const std::exception &) {
    const DWORD error = GetLastError();
    if (error != ERROR_BROKEN_PIPE && error != ERROR_PIPE_NOT_CONNECTED &&
        error != ERROR_NO_DATA)
      throw;
    channelClosed = true;
  }
}
static std::vector<BYTE> tokenInfo(HANDLE token, TOKEN_INFORMATION_CLASS kind) {
  DWORD length = 0;
  GetTokenInformation(token, kind, nullptr, 0, &length);
  require(length && length < 65536, "token information size");
  std::vector<BYTE> result(length);
  require(GetTokenInformation(token, kind, result.data(), length, &length) != 0,
          "GetTokenInformation");
  return result;
}
static wstring sidString(PSID sid) {
  LPWSTR text = nullptr;
  require(ConvertSidToStringSidW(sid, &text) != 0, "ConvertSidToStringSidW");
  Local allocation{reinterpret_cast<HLOCAL>(text)};
  return text;
}
struct Profile {
  wstring name;
  PSID sid = nullptr;
  explicit Profile(const wstring &request) : name(L"Mosaic.Check." + request) {
    const HRESULT status =
        CreateAppContainerProfile(name.c_str(), name.c_str(),
                                  L"Mosaic protected check", nullptr, 0, &sid);
    if (FAILED(status))
      throw std::runtime_error(
          "CreateAppContainerProfile failed (" +
          std::to_string(static_cast<unsigned long>(status)) + ")");
  }
  ~Profile() {
    if (sid) {
      FreeSid(sid);
      DeleteAppContainerProfile(name.c_str());
    }
  }
};

// Rebuild the DACL only on fresh, private staging objects. No access is
// granted to the repository, coordinator state, installed binary or secrets.
static void setStageAcl(const fs::path &file, const wstring &user,
                        const wstring &package, bool writable, bool directory) {
  Handle object(CreateFileW(
      file.c_str(),
      READ_CONTROL | WRITE_DAC | WRITE_OWNER | FILE_READ_ATTRIBUTES,
      FILE_SHARE_READ | FILE_SHARE_WRITE, nullptr, OPEN_EXISTING,
      FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, nullptr));
  require(object.h != INVALID_HANDLE_VALUE, "open staging object");
  BY_HANDLE_FILE_INFORMATION info{};
  require(GetFileInformationByHandle(object.h, &info) != 0,
          "inspect staging object");
  require(!(info.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) &&
              bool(info.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) ==
                  directory &&
              (directory || info.nNumberOfLinks == 1),
          "noncanonical staging object");
  // OWNER RIGHTS overrides implicit WRITE_DAC. Writable objects get modify
  // permissions but no WRITE_DAC/WRITE_OWNER. Only the two output trees
  // inherit this package's writable ACE and low-integrity label.
  wstring inherit = directory ? L"OICI" : L"";
  wstring dacl = L"D:P(A;" + inherit + L";FA;;;" + user + L")(A;" + inherit +
                 L";FA;;;SY)(A;" + inherit + L";RC;;;OW)(A;" + inherit + L";" +
                 (writable ? L"0x1301bf" : L"FRFX") + L";;;" + package + L")";
  if (writable)
    dacl += L"S:(ML;" + inherit + L";NW;;;LW)";
  PSECURITY_DESCRIPTOR sd = nullptr;
  require(ConvertStringSecurityDescriptorToSecurityDescriptorW(
              dacl.c_str(), SDDL_REVISION_1, &sd, nullptr) != 0,
          "build staging ACL");
  Local allocation{reinterpret_cast<HLOCAL>(sd)};
  BOOL present = FALSE, defaulted = FALSE;
  PACL acl = nullptr, sacl = nullptr;
  require(GetSecurityDescriptorDacl(sd, &present, &acl, &defaulted) &&
              present && acl,
          "read staging DACL");
  SECURITY_INFORMATION flags =
      DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION;
  if (writable) {
    require(GetSecurityDescriptorSacl(sd, &present, &sacl, &defaulted) &&
                present && sacl,
            "read staging label");
    flags |= LABEL_SECURITY_INFORMATION;
  }
  DWORD status = SetSecurityInfo(object.h, SE_FILE_OBJECT, flags, nullptr,
                                 nullptr, acl, sacl);
  if (status != ERROR_SUCCESS) {
    SetLastError(status);
    require(false, "set staging DACL and label");
  }
}
static void protectStage(const fs::path &stage, PSID sid) {
  Handle token;
  require(OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &token.h) != 0,
          "open supervisor token");
  const auto uid = tokenInfo(token.h, TokenUser);
  const wstring user = sidString(
                    reinterpret_cast<const TOKEN_USER *>(uid.data())->User.Sid),
                package = sidString(sid);
  setStageAcl(stage, user, package, false, true);
  size_t entries = 0;
  for (const auto &entry : fs::recursive_directory_iterator(stage)) {
    require(++entries <= 120000, "staging entry limit");
    const auto relative = entry.path().lexically_relative(stage);
    auto it = relative.begin();
    const bool inWork = it != relative.end() && *it++ == L"work";
    const bool writable = inWork && it != relative.end() &&
                          (*it == L".overnight-output" || *it == L"dist");
    const DWORD attr = GetFileAttributesW(entry.path().c_str());
    require(attr != INVALID_FILE_ATTRIBUTES &&
                !(attr & FILE_ATTRIBUTE_REPARSE_POINT),
            "reject staging reparse point");
    setStageAcl(entry.path(), user, package, writable,
                (attr & FILE_ATTRIBUTE_DIRECTORY) != 0);
  }
}
static wstring quote(const wstring &arg) {
  wstring result = L"\"";
  size_t slashes = 0;
  for (wchar_t ch : arg) {
    if (ch == L'\\') {
      ++slashes;
      continue;
    }
    if (ch == L'\"')
      result.append(slashes * 2 + 1, L'\\');
    else
      result.append(slashes, L'\\');
    result += ch;
    slashes = 0;
  }
  result.append(slashes * 2, L'\\');
  return result + L'\"';
}
static std::vector<wchar_t> environment(const fs::path &stage) {
  wchar_t system[MAX_PATH]{};
  const UINT size = GetSystemWindowsDirectoryW(system, MAX_PATH);
  require(size && size < MAX_PATH, "Windows directory");
  // Windows also reads LOCALAPPDATA from the explicitly supplied child
  // environment while constructing the package profile. No ambient variables
  // are inherited by the check.
  std::vector<wchar_t> appData(32768);
  const DWORD count = GetEnvironmentVariableW(
      L"LOCALAPPDATA", appData.data(), static_cast<DWORD>(appData.size()));
  require(count && count < appData.size(),
          "missing local AppContainer profile root");
  const wstring temp =
      (stage / L"work" / L".overnight-output" / L"tmp").wstring();
  std::vector<wstring> vars = {L"CI=1",
                               L"HOME=" + temp,
                               L"LOCALAPPDATA=" + wstring(appData.data()),
                               L"MOSAIC_APPROVED_INPUTS=" +
                                   (stage / L"inputs").wstring(),
                               L"PATH=" + (stage / L"runtime").wstring(),
                               L"SystemRoot=" + wstring(system),
                               L"TEMP=" + temp,
                               L"TMP=" + temp,
                               L"USERPROFILE=" + temp,
                               L"WINDIR=" + wstring(system)};
  std::vector<wchar_t> result;
  for (const auto &entry : vars) {
    result.insert(result.end(), entry.begin(), entry.end());
    result.push_back(0);
  }
  result.push_back(0);
  return result;
}
struct Attributes {
  std::vector<BYTE> data;
  LPPROC_THREAD_ATTRIBUTE_LIST list = nullptr;
  explicit Attributes(DWORD count) {
    SIZE_T size = 0;
    InitializeProcThreadAttributeList(nullptr, count, 0, &size);
    require(size != 0, "attribute size");
    data.resize(size);
    list = reinterpret_cast<LPPROC_THREAD_ATTRIBUTE_LIST>(data.data());
    require(InitializeProcThreadAttributeList(list, count, 0, &size) != 0,
            "initialize process attributes");
  }
  ~Attributes() { DeleteProcThreadAttributeList(list); }
  void set(DWORD_PTR key, void *value, SIZE_T size) {
    require(UpdateProcThreadAttribute(list, 0, key, value, size, nullptr,
                                      nullptr) != 0,
            "set process attribute");
  }
};
struct Pipe {
  Handle read, write;
  Pipe() {
    SECURITY_ATTRIBUTES sa{sizeof(sa), nullptr, TRUE};
    require(CreatePipe(&read.h, &write.h, &sa, 65536) != 0,
            "create child output pipe");
    require(SetHandleInformation(read.h, HANDLE_FLAG_INHERIT, 0) != 0,
            "protect child output reader");
  }
};
static bool drain(HANDLE pipe, const char *name, DWORD &total) {
  // A bounded read per turn prevents a noisy process from delaying control.
  DWORD ready = 0;
  if (!PeekNamedPipe(pipe, nullptr, 0, nullptr, &ready, nullptr)) {
    require(GetLastError() == ERROR_BROKEN_PIPE, "peek child pipe");
    return true;
  }
  if (!ready)
    return true;
  BYTE buffer[4096];
  DWORD count = 0;
  require(ReadFile(pipe, buffer, std::min<DWORD>(ready, sizeof(buffer)), &count,
                   nullptr) != 0,
          "read child output");
  const DWORD keep = std::min<DWORD>(count, 256 * 1024 - total);
  string hex;
  hex.reserve(keep * 2);
  constexpr char digits[] = "0123456789abcdef";
  for (DWORD i = 0; i < keep; ++i) {
    hex += digits[buffer[i] >> 4];
    hex += digits[buffer[i] & 15];
  }
  total += keep;
  if (keep)
    emit(string("{\"type\":\"output\",\"stream\":\"") + name + "\",\"hex\":\"" +
         hex + "\"}");
  return keep == count;
}
static bool pending(HANDLE pipe) {
  DWORD ready = 0;
  if (!PeekNamedPipe(pipe, nullptr, 0, nullptr, &ready, nullptr)) {
    require(GetLastError() == ERROR_BROKEN_PIPE, "inspect child output");
    return false;
  }
  return ready != 0;
}
static string control(string &buffer) {
  const HANDLE h = GetStdHandle(STD_INPUT_HANDLE);
  DWORD ready = 0;
  if (!PeekNamedPipe(h, nullptr, 0, nullptr, &ready, nullptr)) {
    DWORD err = GetLastError();
    if (err == ERROR_BROKEN_PIPE || err == ERROR_PIPE_NOT_CONNECTED ||
        err == ERROR_NO_DATA)
      return "control-eof";
    require(false, "peek private control pipe");
  }
  if (ready) {
    char data[32];
    DWORD count = 0;
    require(ReadFile(h, data, std::min<DWORD>(ready, sizeof(data)), &count,
                     nullptr) != 0,
            "read private control pipe");
    buffer.append(data, count);
  }
  require(buffer.size() <= 64, "control input limit");
  const auto pos = buffer.find('\n');
  if (pos == string::npos)
    return "";
  const string command = buffer.substr(0, pos);
  buffer.erase(0, pos + 1);
  require(command == "go" || command == "cancel", "invalid control command");
  return command;
}
// Prove the LPAC property with the suspended child's actual token. The
// TokenIsLessPrivilegedAppContainer information class returns error 87 on
// some supported Server builds. This paired AccessCheck measures the access
// that matters: an explicit package grant succeeds; the ambient grant fails.
static bool grantsRead(HANDLE token, const wstring &user,
                       const wstring &package) {
  const wstring dacl =
      L"O:SYG:SYD:(A;;0x1;;;" + user + L")(A;;0x1;;;" + package + L")";
  PSECURITY_DESCRIPTOR sd = nullptr;
  require(ConvertStringSecurityDescriptorToSecurityDescriptorW(
              dacl.c_str(), SDDL_REVISION_1, &sd, nullptr) != 0,
          "build LPAC access probe");
  Local allocation{reinterpret_cast<HLOCAL>(sd)};
  GENERIC_MAPPING mapping{FILE_GENERIC_READ, FILE_GENERIC_WRITE,
                          FILE_GENERIC_EXECUTE, FILE_ALL_ACCESS};
  alignas(PRIVILEGE_SET) BYTE privileges[1024]{};
  DWORD size = sizeof(privileges), granted = 0;
  BOOL allowed = FALSE;
  require(AccessCheck(sd, token, FILE_READ_DATA, &mapping,
                      reinterpret_cast<PRIVILEGE_SET *>(privileges), &size,
                      &granted, &allowed) != 0,
          "evaluate LPAC access probe");
  return allowed && (granted & FILE_READ_DATA) != 0;
}
static void verifyProcess(HANDLE process, HANDLE job, PSID expectedSid) {
  BOOL assigned = FALSE;
  require(IsProcessInJob(process, job, &assigned) && assigned,
          "check Job membership");
  Handle token;
  require(OpenProcessToken(process, TOKEN_QUERY | TOKEN_DUPLICATE, &token.h) !=
              0,
          "open suspended check token");
  const auto value = tokenInfo(token.h, TokenIsAppContainer);
  require(value.size() == sizeof(DWORD) &&
              *reinterpret_cast<const DWORD *>(value.data()) != 0,
          "verify AppContainer token");
  Handle impersonation;
  require(DuplicateToken(token.h, SecurityImpersonation, &impersonation.h) != 0,
          "duplicate token for access probe");
  const auto user = tokenInfo(token.h, TokenUser);
  const wstring userSid =
      sidString(reinterpret_cast<const TOKEN_USER *>(user.data())->User.Sid);
  require(grantsRead(impersonation.h, userSid, sidString(expectedSid)),
          "LPAC explicit package access control failed");
  require(!grantsRead(impersonation.h, userSid, L"S-1-15-2-1"),
          "LPAC ambient package access was granted");
  const auto package = tokenInfo(token.h, TokenAppContainerSid),
             capabilities = tokenInfo(token.h, TokenCapabilities);
  require(EqualSid(reinterpret_cast<const TOKEN_APPCONTAINER_INFORMATION *>(
                       package.data())
                       ->TokenAppContainer,
                   expectedSid) != 0,
          "verify package SID");
  require(
      reinterpret_cast<const TOKEN_GROUPS *>(capabilities.data())->GroupCount ==
          0,
      "unexpected AppContainer capabilities");
}
static DWORD active(HANDLE job) {
  JOBOBJECT_BASIC_ACCOUNTING_INFORMATION state{};
  require(QueryInformationJobObject(job, JobObjectBasicAccountingInformation,
                                    &state, sizeof(state), nullptr) != 0,
          "query Job accounting");
  return state.ActiveProcesses;
}
static string narrowIdentifier(const wchar_t *s, size_t len, bool hyphens) {
  wstring value(s);
  require(value.size() == len, "invalid request identity length");
  for (size_t i = 0; i < len; ++i) {
    const wchar_t c = value[i];
    if (hyphens && (i == 8 || i == 13 || i == 18 || i == 23))
      require(c == L'-', "invalid request UUID");
    else
      require((c >= L'0' && c <= L'9') || (c >= L'a' && c <= L'f'),
              "invalid request digest");
  }
  return string(value.begin(), value.end());
}

static int run(int argc, wchar_t **argv) {
  require(argc >= 6, "missing supervisor arguments");
  const string request = narrowIdentifier(argv[1], 36, true),
               binding = narrowIdentifier(argv[2], 64, false);
  wchar_t *tail = nullptr;
  const unsigned long timeout = wcstoul(argv[4], &tail, 10);
  require(tail && !*tail && timeout > 0 && timeout <= 600000,
          "invalid supervisor timeout");
  const fs::path stage(argv[5]), receipt(argv[3]);
  require(stage.is_absolute() && receipt.is_absolute() &&
              receipt.filename() == L"completion.json",
          "invalid supervisor paths");
  Profile profile(argv[1]);
  protectStage(stage, profile.sid);
  const fs::path executable = stage / L"runtime" / L"node.exe",
                 cwd = stage / L"work";
  wstring args = quote(executable.wstring());
  for (int i = 6; i < argc; ++i)
    args += L" " + quote(argv[i]);
  auto env = environment(stage);
  Handle job(CreateJobObjectW(nullptr, nullptr));
  require(job.h != nullptr, "create Job Object");
  JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits{};
  limits.BasicLimitInformation.LimitFlags =
      JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE | JOB_OBJECT_LIMIT_ACTIVE_PROCESS;
  limits.BasicLimitInformation.ActiveProcessLimit = 64;
  require(SetInformationJobObject(job.h, JobObjectExtendedLimitInformation,
                                  &limits, sizeof(limits)) != 0,
          "configure Job Object limits");
  SECURITY_CAPABILITIES security{};
  security.AppContainerSid = profile.sid;
  DWORD optOut = PROCESS_CREATION_ALL_APPLICATION_PACKAGES_OPT_OUT;
  Pipe output, error;
  SECURITY_ATTRIBUTES sa{sizeof(sa), nullptr, TRUE};
  Handle input(CreateFileW(L"NUL", GENERIC_READ,
                           FILE_SHARE_READ | FILE_SHARE_WRITE, &sa,
                           OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr));
  require(input.h != INVALID_HANDLE_VALUE, "open null check input");
  HANDLE childHandles[] = {input.h, output.write.h, error.write.h};
  Attributes attrs(4);
  attrs.set(PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES, &security,
            sizeof(security));
  attrs.set(PROC_THREAD_ATTRIBUTE_ALL_APPLICATION_PACKAGES_POLICY, &optOut,
            sizeof(optOut));
  attrs.set(PROC_THREAD_ATTRIBUTE_JOB_LIST, &job.h, sizeof(job.h));
  attrs.set(PROC_THREAD_ATTRIBUTE_HANDLE_LIST, childHandles,
            sizeof(childHandles));
  STARTUPINFOEXW si{};
  si.StartupInfo.cb = sizeof(si);
  si.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
  si.StartupInfo.hStdInput = input.h;
  si.StartupInfo.hStdOutput = output.write.h;
  si.StartupInfo.hStdError = error.write.h;
  si.lpAttributeList = attrs.list;
  PROCESS_INFORMATION process{};
  require(
      CreateProcessW(executable.c_str(), args.data(), nullptr, nullptr, TRUE,
                     EXTENDED_STARTUPINFO_PRESENT | CREATE_UNICODE_ENVIRONMENT |
                         CREATE_NO_WINDOW | CREATE_SUSPENDED,
                     env.data(), cwd.c_str(), &si.StartupInfo, &process) != 0,
      "start suspended protected check");
  Handle leader(process.hProcess), thread(process.hThread);
  output.write.reset();
  error.write.reset();
  input.reset();
  verifyProcess(leader.h, job.h, profile.sid);
  const string ids =
      ",\"requestId\":\"" + request + "\",\"bindingHash\":\"" + binding +
      "\",\"helperPid\":" + std::to_string(GetCurrentProcessId()) +
      ",\"leaderPid\":" + std::to_string(process.dwProcessId);
  emit("{\"schema\":1,\"type\":\"prepared\"" + ids + "}");
  string buffered, reason;
  bool started = false;
  DWORD code = 1, total = 0;
  ULONGLONG deadline = GetTickCount64() + 30000;
  while (reason.empty()) {
    const string command = channelClosed ? "control-eof" : control(buffered);
    if (command == "cancel")
      reason = started ? "cancel" : "startup-cancel";
    else if (command == "control-eof")
      reason = "control-eof";
    else if (command == "go") {
      require(!started, "duplicate GO");
      require(ResumeThread(thread.h) == 1, "resume protected check");
      started = true;
      deadline = GetTickCount64() + timeout;
    }
    if (GetTickCount64() >= deadline)
      reason = "timeout";
    if (started && reason.empty()) {
      if (!drain(output.read.h, "stdout", total) ||
          !drain(error.read.h, "stderr", total))
        reason = "output-limit";
      else if (WaitForSingleObject(leader.h, 0) == WAIT_OBJECT_0) {
        require(GetExitCodeProcess(leader.h, &code) != 0,
                "read leader exit status");
        reason = "exit";
      }
    }
    if (reason.empty())
      Sleep(3);
  }
  // Ending the root process does not establish that ignored-stdio or
  // detached descendants have exited. Terminate the entire Job and query
  // accounting after leader exit before publishing the durable proof.
  if (active(job.h))
    require(TerminateJobObject(job.h, 1) != 0,
            "terminate entire protected Job");
  require(WaitForSingleObject(leader.h, 5000) == WAIT_OBJECT_0,
          "await protected leader exit");
  const ULONGLONG reap = GetTickCount64() + 5000;
  while (active(job.h) != 0) {
    require(GetTickCount64() < reap, "Job still has live processes");
    Sleep(5);
  }
  while (pending(output.read.h) || pending(error.read.h)) {
    if (!drain(output.read.h, "stdout", total) ||
        !drain(error.read.h, "stderr", total)) {
      reason = "output-limit";
      break;
    }
  }
  const string record =
      "{\"schema\":2,\"type\":\"complete\"" + ids + ",\"reason\":\"" + reason +
      "\",\"code\":" + std::to_string(code) +
      ",\"termSignal\":0,\"activeProcesses\":0,\"leaderExited\":true}";
  const auto temp = receipt.parent_path() / L"completion.pending";
  Handle f(CreateFileW(temp.c_str(), GENERIC_WRITE, 0, nullptr, CREATE_NEW,
                       FILE_ATTRIBUTE_NORMAL | FILE_FLAG_WRITE_THROUGH,
                       nullptr));
  require(f.h != INVALID_HANDLE_VALUE, "create private receipt");
  writeAll(f.h, record);
  require(FlushFileBuffers(f.h) != 0, "flush private receipt");
  f.reset();
  require(MoveFileExW(temp.c_str(), receipt.c_str(), MOVEFILE_WRITE_THROUGH) !=
              0,
          "publish private receipt");
  emit(record);
  return 0;
}
// The kernel assigns a GUID to this boot session. A wall-clock estimate from
// uptime/LastBootUpTime cannot prove that all owners of a prior boot are gone.
static int bootId() {
  using Query = LONG(NTAPI *)(ULONG, PVOID, ULONG, PULONG);
  HMODULE ntdll = GetModuleHandleW(L"ntdll.dll");
  require(ntdll != nullptr, "locate system runtime");
  FARPROC symbol = GetProcAddress(ntdll, "NtQuerySystemInformation");
  require(symbol != nullptr, "locate kernel boot query");
  Query query = nullptr;
  static_assert(sizeof(query) == sizeof(symbol));
  std::memcpy(&query, &symbol, sizeof(query));
  struct {
    GUID id;
    ULONG firmwareType;
    ULONGLONG flags;
  } boot{};
  ULONG returned = 0;
  constexpr ULONG systemBootEnvironmentInformation = 90;
  const GUID empty{};
  require(query(systemBootEnvironmentInformation, &boot, sizeof(boot),
                &returned) >= 0 &&
              returned >= sizeof(GUID) &&
              std::memcmp(&boot.id, &empty, sizeof(GUID)) != 0,
          "kernel boot GUID unavailable");
  const GUID &id = boot.id;
  std::printf("%08lx-%04x-%04x-%02x%02x-%02x%02x%02x%02x%02x%02x\n", id.Data1,
              id.Data2, id.Data3, id.Data4[0], id.Data4[1], id.Data4[2],
              id.Data4[3], id.Data4[4], id.Data4[5], id.Data4[6], id.Data4[7]);
  return 0;
}
int wmain(int argc, wchar_t **argv) {
  try {
    if (argc == 2 && wstring(argv[1]) == L"--boot-id")
      return bootId();
    return run(argc, argv);
  } catch (const std::exception &error) {
    std::fprintf(stderr, "Mosaic Windows supervisor: %s\n", error.what());
    return 1;
  }
}
