#define WIN32_LEAN_AND_MEAN
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <windows.h>
#include <cstdio>
#include <regex>
#include <stdexcept>
#include <string>

namespace {
class Handle {
public:
    explicit Handle(HANDLE value) : value_(value) {}
    ~Handle() { if (valid()) CloseHandle(value_); }
    Handle(const Handle&) = delete;
    Handle& operator=(const Handle&) = delete;
    bool valid() const { return value_ != INVALID_HANDLE_VALUE && value_ != nullptr; }
    HANDLE get() const { return value_; }
private:
    HANDLE value_;
};

bool plain_path(const std::wstring& name, bool directory) {
    const DWORD attributes = GetFileAttributesW(name.c_str());
    return attributes != INVALID_FILE_ATTRIBUTES && !(attributes & FILE_ATTRIBUTE_REPARSE_POINT) &&
        ((attributes & FILE_ATTRIBUTE_DIRECTORY) != 0) == directory;
}

bool path_present(const std::wstring& name) {
    return GetFileAttributesW(name.c_str()) != INVALID_FILE_ATTRIBUTES || GetLastError() != ERROR_FILE_NOT_FOUND;
}

std::wstring root_path() {
    wchar_t buffer[32768];
    const DWORD size = GetModuleFileNameW(nullptr, buffer, static_cast<DWORD>(sizeof(buffer) / sizeof(wchar_t)));
    if (!size || size >= sizeof(buffer) / sizeof(wchar_t)) throw std::runtime_error("Cannot resolve the Mosaic launcher");
    const std::wstring self(buffer, size);
    constexpr wchar_t suffix[] = L"\\bin\\mosaic.exe";
    constexpr size_t suffix_size = sizeof(suffix) / sizeof(wchar_t) - 1;
    if (self.size() <= suffix_size ||
        CompareStringOrdinal(self.c_str() + self.size() - suffix_size, -1, suffix, -1, TRUE) != CSTR_EQUAL ||
        !plain_path(self, false)) throw std::runtime_error("Unexpected Mosaic launcher location");
    const std::wstring root = self.substr(0, self.size() - suffix_size);
    if (!plain_path(root, true) || !plain_path(root + L"\\bin", true)) throw std::runtime_error("Unsafe Mosaic installation path");
    return root;
}

std::wstring version_at(const std::wstring& file) {
    Handle handle(CreateFileW(file.c_str(), GENERIC_READ, FILE_SHARE_READ, nullptr, OPEN_EXISTING,
        FILE_FLAG_OPEN_REPARSE_POINT, nullptr));
    BY_HANDLE_FILE_INFORMATION info{};
    char buffer[72] = {};
    DWORD length = 0;
    if (!handle.valid() || !GetFileInformationByHandle(handle.get(), &info) ||
        info.dwFileAttributes & (FILE_ATTRIBUTE_REPARSE_POINT | FILE_ATTRIBUTE_DIRECTORY) ||
        info.nNumberOfLinks != 1 || info.nFileSizeHigh || info.nFileSizeLow >= sizeof(buffer) ||
        !ReadFile(handle.get(), buffer, sizeof(buffer), &length, nullptr) || length != info.nFileSizeLow ||
        length < 2 || buffer[length - 1] != '\n') throw std::runtime_error("Invalid Mosaic version pointer");
    const std::string version(buffer, length - 1);
    static const std::regex syntax(R"((?:0|[1-9][0-9]{0,8})\.(?:0|[1-9][0-9]{0,8})\.(?:0|[1-9][0-9]{0,8})(?:-beta\.(?:0|[1-9][0-9]{0,8}))?)");
    if (!std::regex_match(version, syntax)) throw std::runtime_error("Invalid Mosaic version pointer");
    return std::wstring(version.begin(), version.end());
}

std::wstring quote(const std::wstring& value) {
    std::wstring arg = L"\"";
    size_t slashes = 0;
    for (wchar_t ch : value) {
        if (ch == L'\\') {
            ++slashes;
            continue;
        }
        arg.append(ch == L'"' ? slashes * 2 + 1 : slashes, L'\\');
        arg += ch;
        slashes = 0;
    }
    arg.append(slashes * 2, L'\\');
    arg += L'"';
    return arg;
}

PROCESS_INFORMATION launch(const std::wstring& root, int argc, wchar_t** argv) {
    const std::wstring lock_name = root + L"\\install.lock";
    Handle lock(CreateFileW(lock_name.c_str(), GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE, nullptr,
        OPEN_EXISTING, FILE_FLAG_OPEN_REPARSE_POINT, nullptr));
    BY_HANDLE_FILE_INFORMATION lock_info{};
    if (!lock.valid() || !GetFileInformationByHandle(lock.get(), &lock_info) ||
        lock_info.dwFileAttributes & (FILE_ATTRIBUTE_DIRECTORY | FILE_ATTRIBUTE_REPARSE_POINT) ||
        lock_info.nNumberOfLinks != 1 ||
        (path_present(root + L"\\install-intent.json") && !(argc == 2 && std::wstring(argv[1]) == L"recover"))) {
        throw std::runtime_error("Mosaic installation is pending. Rerun the same verified install command to recover");
    }
    const std::wstring versions = root + L"\\versions";
    const std::wstring version = versions + L"\\" + version_at(root + L"\\current-version.txt");
    const std::wstring runtime = version + L"\\runtime";
    for (const auto& directory : {versions, version, runtime, runtime + L"\\bin", runtime + L"\\src", runtime + L"\\src\\beta"}) {
        if (!plain_path(directory, true)) throw std::runtime_error("The selected Mosaic runtime is unavailable");
    }
    const std::wstring node = runtime + L"\\bin\\node.exe", cli = runtime + L"\\src\\beta\\cli.mjs";
    if (!plain_path(node, false) || !plain_path(cli, false)) throw std::runtime_error("The selected Mosaic runtime is incomplete");
    SetEnvironmentVariableW(L"NODE_OPTIONS", nullptr);
    SetEnvironmentVariableW(L"NODE_PATH", nullptr);
    std::wstring command = quote(node) + L" " + quote(cli);
    for (int i = 1; i < argc; ++i) command += L" " + quote(argv[i]);
    STARTUPINFOW startup{};
    startup.cb = sizeof(startup);
    // MCP uses the caller's actual pipe handles. The executable path is independent of argv.
    startup.hStdInput = GetStdHandle(STD_INPUT_HANDLE);
    startup.hStdOutput = GetStdHandle(STD_OUTPUT_HANDLE);
    startup.hStdError = GetStdHandle(STD_ERROR_HANDLE);
    const auto is_handle = [](HANDLE handle) { return handle && handle != INVALID_HANDLE_VALUE; };
    if (is_handle(startup.hStdInput) && is_handle(startup.hStdOutput) && is_handle(startup.hStdError)) {
        startup.dwFlags = STARTF_USESTDHANDLES;
    }
    PROCESS_INFORMATION process{};
    if (!CreateProcessW(node.c_str(), command.data(), nullptr, nullptr, TRUE, 0, nullptr, nullptr, &startup, &process)) {
        throw std::runtime_error("Could not start the bundled Mosaic runtime");
    }
    return process;
}
}

int wmain(int argc, wchar_t** argv) {
    try {
        const PROCESS_INFORMATION process = launch(root_path(), argc, argv);
        Handle child(process.hProcess), thread(process.hThread);
        DWORD status = 1;
        if (WaitForSingleObject(child.get(), INFINITE) != WAIT_OBJECT_0 || !GetExitCodeProcess(child.get(), &status)) {
            throw std::runtime_error("Could not wait for the bundled Mosaic runtime");
        }
        return static_cast<int>(status);
    } catch (const std::exception& error) {
        std::fprintf(stderr, "%s.\n", error.what());
        return 1;
    }
}
