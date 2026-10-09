import Darwin
import Foundation

@_silgen_name("fork") private func probeFork() -> pid_t

@main
struct ProbeProvider {
    static func main() {
        let args = CommandLine.arguments
        guard args.count >= 2 else { exit(64) }
        if args[1] == "loop", args.count == 4 {
            let command = args[2]
            let heartbeat = args[3]
            while true {
                try? "\(Date().timeIntervalSince1970)\n".write(toFile: heartbeat, atomically: true, encoding: .utf8)
                if (try? String(contentsOfFile: command, encoding: .utf8)) == "kill" {
                    _ = kill(getpid(), SIGKILL)
                }
                usleep(200_000)
            }
        }
        guard args[1] == "probe", args.count == 4 else { exit(64) }
        let operation = args[2]
        let target = args[3]
        switch operation {
        case "read":
            guard (try? String(contentsOfFile: target, encoding: .utf8)) != nil else { exit(1) }
        case "write":
            guard (try? "probe".write(toFile: target, atomically: false, encoding: .utf8)) != nil else { exit(1) }
        case "connect":
            let fd = socket(AF_INET, SOCK_STREAM, 0)
            guard fd >= 0 else { exit(1) }
            defer { close(fd) }
            var address = sockaddr_in()
            address.sin_len = UInt8(MemoryLayout<sockaddr_in>.size)
            address.sin_family = sa_family_t(AF_INET)
            address.sin_port = UInt16(target)!.bigEndian
            address.sin_addr = in_addr(s_addr: in_addr_t(0x7f000001).bigEndian)
            let result = withUnsafePointer(to: &address) {
                $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                    connect(fd, $0, socklen_t(MemoryLayout<sockaddr_in>.size))
                }
            }
            guard result == 0 else { exit(1) }
        case "spawn":
            var pid: pid_t = 0
            let executable = strdup("/usr/bin/true")
            defer { free(executable) }
            var argv: [UnsafeMutablePointer<CChar>?] = [executable, nil]
            let result = argv.withUnsafeMutableBufferPointer {
                posix_spawn(&pid, executable, nil, nil, $0.baseAddress, environ)
            }
            guard result == 0 else { exit(1) }
            var status: Int32 = 0
            _ = waitpid(pid, &status, 0)
        case "fork":
            let pid = probeFork()
            guard pid >= 0 else { exit(1) }
            if pid == 0 { _exit(0) }
            var status: Int32 = 0
            _ = waitpid(pid, &status, 0)
        case "exec":
            let executable = strdup("/usr/bin/true")
            defer { free(executable) }
            var argv: [UnsafeMutablePointer<CChar>?] = [executable, nil]
            argv.withUnsafeMutableBufferPointer { _ = execv(executable, $0.baseAddress) }
            exit(1)
        default:
            exit(64)
        }
        print("ok")
    }
}
