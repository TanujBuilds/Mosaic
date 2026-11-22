// Test-only driver. The child is attached to a real Windows pseudoconsole.
#define NOMINMAX
#define WINVER 0x0A00
#define _WIN32_WINNT 0x0A00
#define NTDDI_VERSION 0x0A000006
#include <windows.h>
#include <algorithm>
#include <cstdio>
#include <string>
#include <vector>

struct Handle {
    HANDLE value = nullptr;
    Handle() = default;
    Handle(const Handle&) = delete;
    ~Handle() { close(); }
    void close() {
        if (value && value != INVALID_HANDLE_VALUE) CloseHandle(value);
        value = nullptr;
    }
};

struct Pseudoconsole {
    HPCON value = nullptr;
    ~Pseudoconsole() { close(); }
    void close() {
        if (value) ClosePseudoConsole(value);
        value = nullptr;
    }
};

struct Attributes {
    std::vector<unsigned char> storage;
    PPROC_THREAD_ATTRIBUTE_LIST value = nullptr;
    ~Attributes() { if (value) DeleteProcThreadAttributeList(value); }
    bool initialize(HPCON console) {
        SIZE_T size = 0;
        InitializeProcThreadAttributeList(nullptr, 1, 0, &size);
        if (!size) return false;
        storage.resize(size);
        auto list = reinterpret_cast<PPROC_THREAD_ATTRIBUTE_LIST>(storage.data());
        if (!InitializeProcThreadAttributeList(list, 1, 0, &size)) return false;
        value = list;
        return UpdateProcThreadAttribute(value, 0, PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE,
            console, sizeof(console), nullptr, nullptr) != 0;
    }
};

static int fail(const char* stage, unsigned long code) {
    std::fprintf(stderr, "ConPTY probe %s (%lu)\n", stage, code);
    return 125;
}

// Preserve argv boundaries for the child process's Windows command-line parser.
static std::wstring quoted(const wchar_t* argument) {
    std::wstring result = L"\"";
    size_t slashes = 0;
    for (; *argument; ++argument) {
        if (*argument == L'\\') {
            ++slashes;
            continue;
        }
        result.append(slashes + (*argument == L'"' ? slashes + 1 : 0), L'\\');
        result += *argument;
        slashes = 0;
    }
    result.append(slashes * 2, L'\\');
    return result + L'"';
}

static DWORD WINAPI drain(void* pipe) {
    const HANDLE source = static_cast<HANDLE>(pipe);
    const HANDLE output = GetStdHandle(STD_OUTPUT_HANDLE);
    char buffer[8192];
    DWORD received = 0;
    size_t forwarded = 0;
    bool healthy = true;
    while (ReadFile(source, buffer, sizeof(buffer), &received, nullptr) && received) {
        forwarded += received;
        if (!healthy || forwarded > 2 * 1024 * 1024) {
            healthy = false;
            continue; // Keep draining so closing the pseudoconsole cannot block.
        }
        DWORD sent = 0;
        healthy = WriteFile(output, buffer, received, &sent, nullptr) && sent == received;
    }
    return healthy ? 0 : 1;
}

int wmain(int argc, wchar_t** argv) {
    if (argc < 2 || argc > 16) return fail("expects an executable and arguments", ERROR_INVALID_PARAMETER);
    std::wstring command;
    for (int i = 1; i < argc; ++i) {
        if (i > 1) command += L' ';
        command += quoted(argv[i]);
    }

    Handle consoleInput, inputToConsole, outputFromConsole, consoleOutput, job;
    if (!CreatePipe(&consoleInput.value, &inputToConsole.value, nullptr, 4096)
        || !CreatePipe(&outputFromConsole.value, &consoleOutput.value, nullptr, 16384))
        return fail("could not create its pipes", GetLastError());
    job.value = CreateJobObjectW(nullptr, nullptr);
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits{};
    limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    if (!job.value || !SetInformationJobObject(job.value, JobObjectExtendedLimitInformation, &limits, sizeof(limits)))
        return fail("could not limit the child lifetime", GetLastError());

    Pseudoconsole console;
    const HRESULT result = CreatePseudoConsole({120, 40}, consoleInput.value, consoleOutput.value, 0, &console.value);
    if (FAILED(result)) return fail("could not create the pseudoconsole", static_cast<unsigned long>(result));

    Attributes attributes;
    if (!attributes.initialize(console.value)) return fail("could not attach the pseudoconsole", GetLastError());
    STARTUPINFOEXW startup{};
    startup.StartupInfo.cb = sizeof(startup);
    startup.lpAttributeList = attributes.value;
    PROCESS_INFORMATION created{};
    if (!CreateProcessW(argv[1], command.data(), nullptr, nullptr, FALSE,
        EXTENDED_STARTUPINFO_PRESENT | CREATE_SUSPENDED, nullptr, nullptr, &startup.StartupInfo, &created))
        return fail("could not launch the observer", GetLastError());
    Handle child, mainThread;
    child.value = created.hProcess;
    mainThread.value = created.hThread;
    consoleInput.close();
    consoleOutput.close();
    if (!AssignProcessToJobObject(job.value, child.value)) {
        const DWORD error = GetLastError();
        TerminateProcess(child.value, 125);
        return fail("could not bind the observer to its test job", error);
    }

    Handle reader;
    reader.value = CreateThread(nullptr, 0, drain, outputFromConsole.value, 0, nullptr);
    if (!reader.value) {
        const DWORD error = GetLastError();
        job.close();
        return fail("could not drain pseudoconsole output", error);
    }

    DWORD exitCode = 125;
    const bool resumed = ResumeThread(mainThread.value) != static_cast<DWORD>(-1);
    const auto deadline = GetTickCount64() + 35'000;
    const HANDLE input = GetStdHandle(STD_INPUT_HANDLE);
    size_t keyBytes = 0;
    bool completed = false;
    while (resumed && GetTickCount64() < deadline) {
        const DWORD state = WaitForSingleObject(child.value, 20);
        if (state == WAIT_OBJECT_0) {
            completed = GetExitCodeProcess(child.value, &exitCode) != 0;
            break;
        }
        if (state != WAIT_TIMEOUT) break;
        DWORD available = 0;
        if (!PeekNamedPipe(input, nullptr, 0, nullptr, &available, nullptr) || !available) continue;
        char keys[64];
        DWORD received = 0, sent = 0;
        if (!ReadFile(input, keys, std::min(available, static_cast<DWORD>(sizeof(keys))), &received, nullptr)) break;
        keyBytes += received;
        if (keyBytes > 256 || !WriteFile(inputToConsole.value, keys, received, &sent, nullptr) || sent != received) break;
    }

    job.close();
    inputToConsole.close();
    console.close();
    if (WaitForSingleObject(reader.value, 3000) != WAIT_OBJECT_0) {
        CancelSynchronousIo(reader.value);
        return fail("output did not close", ERROR_TIMEOUT);
    }
    DWORD outputCode = 0;
    if (!GetExitCodeThread(reader.value, &outputCode) || outputCode) return fail("could not forward output", outputCode);
    if (!completed) return fail("observer deadline or input error", ERROR_TIMEOUT);
    return static_cast<int>(exitCode);
}
