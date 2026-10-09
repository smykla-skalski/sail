import Darwin
import Foundation

struct Child {
    let pid: pid_t
    let generation: String
    let commandFile: String
    let heartbeatFile: String
}

struct QueuedWork {
    let scope: String
    let generation: String
    let effectFile: String
}

@main
struct ProbeAgent {
    static func main() {
        guard CommandLine.arguments.count == 8 else { exit(64) }
        let socketPath = CommandLine.arguments[1]
        let providerPath = CommandLine.arguments[2]
        let stateRoot = CommandLine.arguments[3]
        let profiles = [CommandLine.arguments[4]: CommandLine.arguments[5], CommandLine.arguments[6]: CommandLine.arguments[7]]
        try? FileManager.default.removeItem(atPath: socketPath)
        let fd = socket(AF_UNIX, SOCK_STREAM, 0)
        guard fd >= 0 else { exit(1) }
        var address = sockaddr_un()
        address.sun_family = sa_family_t(AF_UNIX)
        let bytes = Array(socketPath.utf8CString)
        guard bytes.count <= MemoryLayout.size(ofValue: address.sun_path) else { exit(1) }
        withUnsafeMutableBytes(of: &address.sun_path) { raw in
            for (index, byte) in bytes.enumerated() { raw[index] = UInt8(bitPattern: byte) }
        }
        let bound = withUnsafePointer(to: &address) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                bind(fd, $0, socklen_t(MemoryLayout<sockaddr_un>.size))
            }
        }
        guard bound == 0, listen(fd, 16) == 0 else { exit(1) }
        _ = chmod(socketPath, 0o600)
        let serviceGeneration = UUID().uuidString
        var children: [String: Child] = [:]
        var queued: [String: QueuedWork] = [:]
        while true {
            let connection = accept(fd, nil, nil)
            if connection < 0 { continue }
            var buffer = [UInt8](repeating: 0, count: 8192)
            let count = read(connection, &buffer, buffer.count)
            var answer: [String: Any] = ["service": serviceGeneration, "servicePid": getpid()]
            if count > 0,
               let request = try? JSONSerialization.jsonObject(with: Data(buffer.prefix(count))) as? [String: String],
               let operation = request["op"] {
                let scope = request["scope"] ?? ""
                switch operation {
                case "ping":
                    answer["ok"] = true
                case "ensure":
                    guard let profilePath = profiles[scope] else {
                        answer["error"] = "unknown project key"
                        break
                    }
                    if let child = children[scope] {
                        var status: Int32 = 0
                        if waitpid(child.pid, &status, WNOHANG) == 0 {
                            answer["provider"] = child.generation
                            answer["providerPid"] = child.pid
                            answer["heartbeat"] = child.heartbeatFile
                            break
                        }
                        children.removeValue(forKey: scope)
                    }
                    let generation = UUID().uuidString
                    let directory = stateRoot + "/" + scope
                    do {
                        try FileManager.default.createDirectory(atPath: directory, withIntermediateDirectories: true)
                        let command = directory + "/command-" + generation
                        let heartbeat = directory + "/heartbeat-" + generation
                        let arguments = ["/usr/bin/sandbox-exec", "-f", profilePath, providerPath, "loop", command, heartbeat]
                        var pid: pid_t = 0
                        let code = spawn(path: arguments[0], arguments: arguments, pid: &pid)
                        if code != 0 { answer["error"] = "spawn failed: \(code)"; break }
                        let child = Child(pid: pid, generation: generation, commandFile: command, heartbeatFile: heartbeat)
                        children[scope] = child
                        answer["provider"] = generation
                        answer["providerPid"] = pid
                        answer["heartbeat"] = heartbeat
                    } catch { answer["error"] = "state directory failed: \(error)" }
                case "kill-provider":
                    if let child = children[scope] {
                        do { try "kill".write(toFile: child.commandFile, atomically: true, encoding: .utf8); answer["ok"] = true }
                        catch { answer["error"] = "command write failed: \(error)" }
                    } else { answer["error"] = "unknown provider" }
                case "cancel":
                    if let child = children.removeValue(forKey: scope) {
                        // The entry remains an unreaped direct posix_spawn child until this wait.
                        _ = kill(child.pid, SIGTERM)
                        var status: Int32 = 0
                        let reaped = waitpid(child.pid, &status, 0)
                        answer["cancelled"] = child.generation
                        answer["reaped"] = reaped == child.pid
                        answer["childExitStatus"] = status
                    } else { answer["error"] = "unknown provider" }
                case "queue-work":
                    if let child = children[scope] {
                        let id = UUID().uuidString
                        let effect = stateRoot + "/" + scope + "/queue-effect-" + id
                        queued[id] = QueuedWork(scope: scope, generation: child.generation, effectFile: effect)
                        answer["id"] = id
                        answer["effectFile"] = effect
                    } else { answer["error"] = "unknown provider" }
                case "run-queued":
                    if let id = request["id"], let work = queued.removeValue(forKey: id) {
                        answer["effectFile"] = work.effectFile
                        if children[work.scope]?.generation == work.generation {
                            do {
                                try work.generation.write(toFile: work.effectFile, atomically: true, encoding: .utf8)
                                answer["result"] = "executed"
                            } catch { answer["error"] = "effect write failed: \(error)" }
                        } else { answer["result"] = "stale" }
                    } else { answer["error"] = "unknown queued work" }
                case "kill-service":
                    answer["ok"] = true
                default:
                    answer["error"] = "unknown operation"
                }
                if operation == "kill-service" {
                    send(connection, answer)
                    close(connection)
                    _ = kill(getpid(), SIGKILL)
                }
            } else { answer["error"] = "invalid request" }
            send(connection, answer)
            close(connection)
        }
    }

    private static func send(_ fd: Int32, _ value: [String: Any]) {
        guard let data = try? JSONSerialization.data(withJSONObject: value) else { return }
        _ = data.withUnsafeBytes { write(fd, $0.baseAddress, $0.count) }
    }

    private static func spawn(path: String, arguments: [String], pid: inout pid_t) -> Int32 {
        let strings = arguments.map { strdup($0) }
        defer { strings.forEach { free($0) } }
        var pointers = strings + [nil]
        return path.withCString { executable in
            pointers.withUnsafeMutableBufferPointer { argv in
                posix_spawn(&pid, executable, nil, nil, argv.baseAddress, environ)
            }
        }
    }
}
