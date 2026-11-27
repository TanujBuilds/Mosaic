import Foundation
import CoreFoundation
import Darwin

enum CodexChatCodec {
    static let listRequest:[String:Any] = ["jsonrpc":"2.0","id":2,"method":"thread/list","params":["limit":20,"sortKey":"updated_at","sortDirection":"desc","sourceKinds":["cli","vscode","appServer"],"archived":false,"useStateDbOnly":true]]
    static let initializeRequest:[String:Any] = ["jsonrpc":"2.0","id":1,"method":"initialize","params":["clientInfo":["name":"mosaic_desktop","title":"Mosaic","version":"1.2.1"],"capabilities":["experimentalApi":false]]]
    static func validID(_ id:String)->Bool { id.range(of:"^[a-fA-F0-9]{8}(?:-[a-fA-F0-9]{4}){3}-[a-fA-F0-9]{12}$",options:.regularExpression) != nil }
    static func rows(_ raw:[String:Any]) throws -> [[String:Any]] {
        guard let data=raw["data"] as? [[String:Any]] else { throw MosaicError.invalidCommand }
        return data.prefix(20).compactMap { row in
            guard let id=row["id"] as? String,validID(id) else { return nil }
            let supplied=row["name"] as? String
            let title=(supplied?.isEmpty == false ? supplied! : "Untitled chat")
            guard title.count<=500 else { return nil }
            let cwd=row["cwd"] as? String ?? ""
            let project=cwd.hasPrefix("/") && cwd.count<=4096 ? URL(fileURLWithPath:cwd).lastPathComponent : "Project not reported"
            var at:Any=NSNull()
            if let number=row["updatedAt"] as? NSNumber,CFGetTypeID(number) != CFBooleanGetTypeID(),number.doubleValue.isFinite,number.doubleValue>0 { at=number }
            // Discard previews, messages, model configuration and all other server fields.
            return ["id":id.lowercased(),"title":title,"project":project,"updatedAt":at]
        }
    }
    static func link(id:String,known:Set<String>)->URL? {
        guard validID(id),known.contains(id.lowercased()) else { return nil }
        return URL(string:"codex://threads/"+id.lowercased())
    }
}

// One bounded metadata-only process per refresh. No socket/service is installed.
final class CodexChatReader {
    private let queue=DispatchQueue(label:"dev.mosaic.recent-chats")
    private let lock=NSLock()
    private var known=Set<String>()
    private var cached:[[String:Any]]=[]
    private var fetched:TimeInterval=0
    private var process:Process?
    private var retiring:[Process]=[]
    private var input:FileHandle?
    private var output:FileHandle?
    private var buffer=Data()
    private var received=0
    private var initialized=false
    private var stopped=false
    private var waiters:[(Result<[[String:Any]],Error>)->Void]=[]
    private let maximumBytes=2_097_152
    private var timeout:TimeInterval=10
    private(set) var lastProcessIdentifier:Int32?
    init() {}
    #if MOSAIC_TESTING
    private var testExecutable:URL?
    init(testExecutable:URL,timeout:TimeInterval) { self.testExecutable=testExecutable;self.timeout=timeout }
    #endif
    func link(_ id:String)->URL? { lock.lock();defer{lock.unlock()};return CodexChatCodec.link(id:id,known:known) }
    func list(_ completion:@escaping(Result<[[String:Any]],Error>)->Void) {
        queue.async {
            guard !self.stopped else { DispatchQueue.main.async{completion(.failure(MosaicError.invalidCommand))};return }
            if Date().timeIntervalSince1970-self.fetched<10 {
                let rows=self.cached;DispatchQueue.main.async{completion(.success(rows))};return
            }
            self.waiters.append(completion)
            if self.process != nil { return }
            self.start()
        }
    }
    func shutdown() {
        queue.sync {
            stopped=true
            // Terminate only this reader's owned metadata child before the app exits.
            if let child=process,child.isRunning { Darwin.kill(child.processIdentifier,SIGKILL) }
            for child in retiring where child.isRunning { Darwin.kill(child.processIdentifier,SIGKILL) }
            finish(.failure(MosaicError.invalidCommand))
        }
    }
    private func executable()->URL? {
        #if MOSAIC_TESTING
        if let executable=testExecutable { return executable }
        #endif
        let home=FileManager.default.homeDirectoryForCurrentUser
        let candidates=[home.appendingPathComponent(".local/bin/codex"),URL(fileURLWithPath:"/opt/homebrew/bin/codex"),URL(fileURLWithPath:"/usr/local/bin/codex")]
        return candidates.first{FileManager.default.isExecutableFile(atPath:$0.path)}
    }
    private func start() {
        guard let executable=executable() else { finish(.failure(MosaicError.invalidCommand));return }
        let child=Process(),stdin=Pipe(),stdout=Pipe()
        child.executableURL=executable
        child.arguments=["app-server","--listen","stdio://"]
        child.currentDirectoryURL=FileManager.default.homeDirectoryForCurrentUser
        child.standardInput=stdin;child.standardOutput=stdout
        child.standardError=FileHandle.nullDevice
        process=child;input=stdin.fileHandleForWriting;output=stdout.fileHandleForReading
        buffer=Data();received=0;initialized=false
        stdout.fileHandleForReading.readabilityHandler={ [weak self,weak child] handle in
            let bytes=handle.availableData
            self?.queue.async { guard let self=self,let child=child,self.process===child else{return};if bytes.isEmpty{self.finish(.failure(MosaicError.invalidCommand))}else{self.receive(bytes)} }
        }
        child.terminationHandler={ [weak self] child in self?.queue.async{guard let self=self else{return};self.retiring.removeAll{$0===child};guard self.process===child else{return};self.finish(.failure(MosaicError.invalidCommand))} }
        do { try child.run();lastProcessIdentifier=child.processIdentifier;try send(CodexChatCodec.initializeRequest) }
        catch { finish(.failure(MosaicError.invalidCommand));return }
        queue.asyncAfter(deadline:.now()+timeout){ [weak self,weak child] in guard let self=self,let child=child,self.process===child else{return};self.finish(.failure(MosaicError.invalidCommand)) }
    }
    private func send(_ object:[String:Any]) throws {
        var bytes=try JSONSerialization.data(withJSONObject:object);bytes.append(10)
        try input?.write(contentsOf:bytes)
    }
    private func receive(_ bytes:Data) {
        received+=bytes.count
        guard received<=maximumBytes else { finish(.failure(MosaicError.invalidCommand));return }
        buffer.append(bytes)
        while let end=buffer.firstIndex(of:10) {
            let line=Data(buffer[..<end]);buffer.removeSubrange(...end)
            guard let object=(try? JSONSerialization.jsonObject(with:line)) as? [String:Any] else { finish(.failure(MosaicError.invalidCommand));return }
            if object["id"] as? Int == 1 && !initialized {
                guard object["error"] == nil,object["result"] != nil else { finish(.failure(MosaicError.invalidCommand));return }
                initialized=true
                do { try send(["jsonrpc":"2.0","method":"initialized"]);try send(CodexChatCodec.listRequest) }
                catch { finish(.failure(MosaicError.invalidCommand));return }
            } else if object["id"] as? Int == 2 && initialized {
                guard object["error"] == nil,let result=object["result"] as? [String:Any],let rows=try? CodexChatCodec.rows(result) else { finish(.failure(MosaicError.invalidCommand));return }
                cached=rows;fetched=Date().timeIntervalSince1970
                lock.lock();known=Set(rows.compactMap{$0["id"] as? String});lock.unlock()
                finish(.success(rows));return
            }
            // Unsolicited protocol notifications never reach the renderer or a log.
        }
    }
    private func finish(_ result:Result<[[String:Any]],Error>) {
        let child=process;process=nil
        output?.readabilityHandler=nil
        // A readability callback retains its handle. Releasing it after detaching avoids closing under an in-flight read.
        try? input?.close();input=nil;output=nil;buffer=Data()
        if let child=child,child.isRunning {
            retiring.append(child)
            child.terminate()
            queue.asyncAfter(deadline:.now()+0.5){if child.isRunning{Darwin.kill(child.processIdentifier,SIGKILL)}}
        }
        let callbacks=waiters;waiters=[]
        DispatchQueue.main.async{callbacks.forEach{$0(result)}}
    }
}
