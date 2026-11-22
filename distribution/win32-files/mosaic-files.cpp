// Per-user file operations for the installed Windows coordinator. Build with
// cl /std:c++17 /EHsc mosaic-files.cpp advapi32.lib ole32.lib
#define NOMINMAX
#include <windows.h>
#include <aclapi.h>
#include <sddl.h>
#include <objbase.h>
#include <fcntl.h>
#include <io.h>
#include <cstdio>
#include <cwctype>
#include <cstring>
#include <string>
#include <vector>
#include <stdexcept>
#include <memory>
#include <algorithm>

#pragma comment(lib, "advapi32.lib")
#pragma comment(lib, "ole32.lib")
using std::wstring;
struct Failure : std::runtime_error {
    DWORD code;
    Failure(const char* text, DWORD value = ERROR_INVALID_DATA) : std::runtime_error(text), code(value) {}
};
struct Handle {
    HANDLE h;
    explicit Handle(HANDLE value) : h(value) {}
    ~Handle() { if (h != INVALID_HANDLE_VALUE && h != nullptr) CloseHandle(h); }
    Handle(Handle&& other) noexcept : h(other.h) { other.h = INVALID_HANDLE_VALUE; }
    Handle(const Handle&) = delete;
};
struct LocalRelease { void operator()(void* p) const { LocalFree(p); } };
using LocalMemory = std::unique_ptr<void, LocalRelease>;

static void require(bool ok, const char* error) {
    if (!ok) throw Failure(error);
}
static Handle openPath(const wstring& file, DWORD access, DWORD share, DWORD creation = OPEN_EXISTING, SECURITY_ATTRIBUTES* security = nullptr) {
    HANDLE h = CreateFileW(file.c_str(), access, share, security, creation,
        FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_BACKUP_SEMANTICS, nullptr);
    if (h == INVALID_HANDLE_VALUE) throw Failure("Unable to open path", GetLastError());
    return Handle(h);
}
static void checkType(HANDLE h, bool directory) {
    BY_HANDLE_FILE_INFORMATION info{};
    require(GetFileType(h) == FILE_TYPE_DISK && GetFileInformationByHandle(h, &info), "Disk handle required");
    require(!(info.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT), "Reparse points are unsupported");
    require(bool(info.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) == directory, "Unexpected file type");
    if (!directory) require(info.nNumberOfLinks == 1, "A single-link file is required");
}
struct User {
    std::vector<BYTE> buffer;
    LocalMemory security;
    SECURITY_ATTRIBUTES attrs{sizeof(SECURITY_ATTRIBUTES),nullptr,FALSE};
    PSID sid() { return reinterpret_cast<TOKEN_USER*>(buffer.data())->User.Sid; }
    User() {
        HANDLE raw;
        require(OpenProcessToken(GetCurrentProcess(),TOKEN_QUERY,&raw),"Current user token unavailable");
        Handle token(raw); DWORD needed = 0;
        GetTokenInformation(token.h,TokenUser,nullptr,0,&needed);
        require(needed > 0,"Current user SID unavailable"); buffer.resize(needed);
        require(GetTokenInformation(token.h,TokenUser,buffer.data(),needed,&needed),"Cannot read current SID");
        LPWSTR text;
        require(ConvertSidToStringSidW(sid(),&text),"Cannot format current SID"); LocalMemory holder(text);
        const wstring sddl = L"O:" + wstring(text) + L"D:P(A;OICI;FA;;;" + wstring(text) + L")(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)";
        PSECURITY_DESCRIPTOR sd;
        require(ConvertStringSecurityDescriptorToSecurityDescriptorW(sddl.c_str(),SDDL_REVISION_1,&sd,nullptr),"Cannot create private descriptor");
        security.reset(sd); attrs.lpSecurityDescriptor=sd;
    }
    void check(HANDLE h) {
        PSID owner=nullptr; PACL acl=nullptr; PSECURITY_DESCRIPTOR sd=nullptr;
        DWORD err=GetSecurityInfo(h,SE_FILE_OBJECT,OWNER_SECURITY_INFORMATION|DACL_SECURITY_INFORMATION,&owner,nullptr,&acl,nullptr,&sd);
        LocalMemory holder(sd);
        require(err==ERROR_SUCCESS && owner && acl && EqualSid(owner,sid()),"Owned private ACL required");
        for (DWORD i=0; i<acl->AceCount; ++i) {
            void* raw=nullptr; require(GetAce(acl,i,&raw),"Invalid private ACL");
            auto header=static_cast<ACE_HEADER*>(raw);
            if (header->AceType==ACCESS_DENIED_ACE_TYPE) continue;
            require(header->AceType==ACCESS_ALLOWED_ACE_TYPE,"Unsupported private ACL");
            PSID grantee=&static_cast<ACCESS_ALLOWED_ACE*>(raw)->SidStart;
            require(EqualSid(grantee,sid()) || IsWellKnownSid(grantee,WinLocalSystemSid) ||
                IsWellKnownSid(grantee,WinBuiltinAdministratorsSid),"Unexpected access to private path");
        }
    }
};
// Pin each existing directory without delete/write sharing during lookup. Apply
// reparse checks to each handle, including the final component.
static std::vector<Handle> parents(const wstring& path, bool make, User& user) {
    require(path.size()>3 && iswalpha(path[0]) && path[1]==L':' && path[2]==L'\\',"Absolute drive path required");
    require(path.find_first_of(L"/:*?\"<>|",2)==wstring::npos,"Invalid local path character");
    wstring root=path.substr(0,3);
    require(GetDriveTypeW(root.c_str())==DRIVE_FIXED,"Fixed local drive required");
    std::vector<Handle> pins;
    auto pin=[&](const wstring& dir) {
        auto h=openPath(dir,FILE_READ_ATTRIBUTES,FILE_SHARE_READ);
        checkType(h.h,true);
        // Check physical path on the open handle. An ancestor rename is held by
        // the directory handle; aliases and reparse transitions fail closed.
        std::vector<wchar_t> actual(32768);
        DWORD n=GetFinalPathNameByHandleW(h.h,actual.data(),DWORD(actual.size()),FILE_NAME_NORMALIZED|VOLUME_NAME_DOS);
        require(n>0 && n<actual.size() && _wcsicmp(actual.data(),(L"\\\\?\\"+dir).c_str())==0,"Noncanonical directory");
        pins.emplace_back(std::move(h));
    };
    pin(root);
    for(size_t start=3;start<=path.size();) {
        size_t split=path.find(L'\\',start); wstring part=path.substr(start,split-start);
        require(!part.empty() && part.back()!=L'.' && part.back()!=L' ',"Invalid path component");
        wstring stem=part.substr(0,part.find(L'.'));std::transform(stem.begin(),stem.end(),stem.begin(),::towupper);
        require(stem!=L"NUL" && stem!=L"CON" && stem!=L"PRN" && stem!=L"AUX" && stem!=L"CONIN$" && stem!=L"CONOUT$" &&
          !(stem.size()==4 && (stem.substr(0,3)==L"COM"||stem.substr(0,3)==L"LPT") && iswdigit(stem[3])),"Reserved device name");
        for (wchar_t c : part) require(c>=32,"Control character in path");
        if(split==wstring::npos)break;
        wstring dir=path.substr(0,split);
        if(make && !CreateDirectoryW(dir.c_str(),&user.attrs) && GetLastError()!=ERROR_ALREADY_EXISTS)throw Failure("Cannot create parent directory");
        pin(dir);start=split+1;
    }
    return pins;
}
static void streamFile(HANDLE h, unsigned long long max) {
    LARGE_INTEGER size{}; require(GetFileSizeEx(h,&size) && size.QuadPart>=0 && static_cast<unsigned long long>(size.QuadPart)<=max,"File exceeds read limit");
    char buf[32768]; unsigned long long total=0; DWORD n;
    for (;;) {
        require(ReadFile(h,buf,sizeof buf,&n,nullptr),"Cannot read file"); if(!n)break;
        total+=n; require(total<=max && fwrite(buf,1,n,stdout)==n,"Cannot return bounded file");
    }
    require(total==static_cast<unsigned long long>(size.QuadPart),"File changed while reading");
}
static void atomicWrite(const wstring& dest, User& user) {
    GUID id; require(CoCreateGuid(&id)==S_OK,"Cannot allocate temporary name"); wchar_t name[40]{};
    require(StringFromGUID2(id,name,40)>0,"Cannot format temporary name");
    wstring tmp=dest.substr(0,dest.rfind(L'\\')+1)+L".mosaic-beta-"+name;
    // A same-directory private temporary file gives replacement a new private ACL.
    auto tmpFile=openPath(tmp,GENERIC_WRITE|DELETE,0,CREATE_NEW,&user.attrs);
    try {
        char buf[32768]; size_t n; DWORD wrote;
        while((n=fread(buf,1,sizeof buf,stdin))>0)
            require(WriteFile(tmpFile.h,buf,DWORD(n),&wrote,nullptr) && wrote==n,"Cannot write temporary file");
        require(!ferror(stdin) && FlushFileBuffers(tmpFile.h),"Cannot flush temporary file");
        const size_t bytes=dest.size()*sizeof(wchar_t);
        std::vector<BYTE> mem(sizeof(FILE_RENAME_INFO)+bytes); auto rename=reinterpret_cast<FILE_RENAME_INFO*>(mem.data());
        rename->ReplaceIfExists=TRUE;rename->FileNameLength=DWORD(bytes);memcpy(rename->FileName,dest.data(),bytes);
        require(SetFileInformationByHandle(tmpFile.h,FileRenameInfo,rename,DWORD(mem.size())),"Cannot replace destination");
    }catch(...){ FILE_DISPOSITION_INFO del{TRUE};SetFileInformationByHandle(tmpFile.h,FileDispositionInfo,&del,sizeof(del));throw; }
}
int wmain(int argc,wchar_t** argv) {
    try {
        require(argc>=3,"Missing operation or path");User user;
        wstring op=argv[1],file=argv[2];bool directory=op==L"mkdir"||op==L"directory"||op==L"private-directory";
        auto pins=parents(file,op==L"mkdir",user);
        if(op==L"mkdir" && !CreateDirectoryW(file.c_str(),&user.attrs) && GetLastError()!=ERROR_ALREADY_EXISTS) throw Failure("Cannot create private directory");
        if(op==L"write"){
            _setmode(_fileno(stdin),_O_BINARY);atomicWrite(file,user);return 0;
        }
        require(directory||op==L"read"||op==L"read-private"||op==L"private-file","Unsupported operation");
        bool read=op==L"read"||op==L"read-private";
        auto h=openPath(file,FILE_READ_ATTRIBUTES|READ_CONTROL|(read?GENERIC_READ:0),read?FILE_SHARE_READ:(FILE_SHARE_READ|FILE_SHARE_WRITE));
        checkType(h.h,directory);
        if(op==L"read-private"||op==L"private-file"||op==L"private-directory")user.check(h.h);
        if(read){require(argc==4,"Read limit required");wchar_t* end;auto max=_wcstoui64(argv[3],&end,10);
            require(*argv[3] && !*end,"Invalid read limit");_setmode(_fileno(stdout),_O_BINARY);streamFile(h.h,max);}
        return 0;
    }catch(const Failure& e){fprintf(stderr,"%s (%lu)\n",e.what(),e.code);return e.code==ERROR_FILE_NOT_FOUND||e.code==ERROR_PATH_NOT_FOUND?2:1;}
    catch(...){fputs("Windows file operation failed\n",stderr);return 1;}
}
