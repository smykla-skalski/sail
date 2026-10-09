import Darwin
import Foundation
import ServiceManagement

@main
struct ProbeApp {
    static func main() {
        guard CommandLine.arguments.count >= 3 else {
            fputs("usage: ProbeApp <register|unregister|status|request|serve> <plist-or-socket> [json]\n", stderr)
            exit(64)
        }
        let operation = CommandLine.arguments[1]
        let target = CommandLine.arguments[2]
        if operation == "crash" { _ = kill(getpid(), SIGKILL); exit(1) }
        do {
            if operation == "serve" {
                while let line = readLine() {
                    if let input = try? JSONSerialization.jsonObject(with: Data(line.utf8)) as? [String: String],
                       input["op"] == "crash-window" {
                        _ = kill(getpid(), SIGKILL)
                    }
                    do { print(try request(socketPath: target, payload: line)) }
                    catch { print("{\"error\":\"request failed\"}") }
                    fflush(stdout)
                }
            } else if operation == "request" {
                guard CommandLine.arguments.count == 4 else { throw ProbeError.input }
                print(try request(socketPath: target, payload: CommandLine.arguments[3]))
            } else {
                let service = SMAppService.agent(plistName: target)
                switch operation {
                case "register":
                    try service.register()
                case "unregister":
                    try service.unregister()
                case "status":
                    break
                default:
                    throw ProbeError.input
                }
                let status: String
                switch service.status {
                case .notRegistered: status = "notRegistered"
                case .enabled: status = "enabled"
                case .requiresApproval: status = "requiresApproval"
                case .notFound: status = "notFound"
                @unknown default: status = "unknown"
                }
                print("{\"status\":\"\(status)\"}")
            }
        } catch {
            fputs("\(error)\n", stderr)
            exit(1)
        }
    }

    private static func request(socketPath: String, payload: String) throws -> String {
        let fd = socket(AF_UNIX, SOCK_STREAM, 0)
        guard fd >= 0 else { throw ProbeError.socket }
        defer { close(fd) }
        var address = sockaddr_un()
        address.sun_family = sa_family_t(AF_UNIX)
        let bytes = Array(socketPath.utf8CString)
        guard bytes.count <= MemoryLayout.size(ofValue: address.sun_path) else { throw ProbeError.input }
        withUnsafeMutableBytes(of: &address.sun_path) { raw in
            for (index, byte) in bytes.enumerated() { raw[index] = UInt8(bitPattern: byte) }
        }
        let connected = withUnsafePointer(to: &address) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                connect(fd, $0, socklen_t(MemoryLayout<sockaddr_un>.size))
            }
        }
        guard connected == 0 else { throw ProbeError.socket }
        let message = Array((payload + "\n").utf8)
        guard message.withUnsafeBytes({ write(fd, $0.baseAddress, $0.count) }) == message.count else {
            throw ProbeError.socket
        }
        var response = [UInt8](repeating: 0, count: 8192)
        let count = read(fd, &response, response.count)
        guard count > 0 else { throw ProbeError.socket }
        return String(decoding: response.prefix(count), as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines)
    }
}

enum ProbeError: Error { case input, socket }
