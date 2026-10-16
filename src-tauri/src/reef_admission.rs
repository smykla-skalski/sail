#[cfg(unix)]
use serde::Deserialize;
use serde::Serialize;
use std::collections::HashMap;
use std::sync::{Arc, Mutex, OnceLock};

#[derive(Clone, Serialize)]
pub struct AdmissionStatus {
    state: String,
    reason: String,
}

struct Lease {
    status: AdmissionStatus,
    cancelled: bool,
    #[cfg(unix)]
    stream: Option<std::os::unix::net::UnixStream>,
}

type Leases = Mutex<HashMap<String, Arc<Mutex<Lease>>>>;

fn leases() -> &'static Leases {
    static LEASES: OnceLock<Leases> = OnceLock::new();
    LEASES.get_or_init(|| Mutex::new(HashMap::new()))
}

fn status(state: &str, reason: impl Into<String>) -> AdmissionStatus {
    AdmissionStatus {
        state: state.into(),
        reason: reason.into(),
    }
}

#[tauri::command]
pub fn reef_admission_request(id: String, kind: String) -> Result<(), String> {
    if !matches!(kind.as_str(), "agent" | "browser") || id.is_empty() || id.len() > 128 {
        return Err("Invalid Reef admission request.".into());
    }
    let lease = Arc::new(Mutex::new(Lease {
        status: status("checking", "Checking Reef admission…"),
        cancelled: false,
        #[cfg(unix)]
        stream: None,
    }));
    {
        let mut entries = leases().lock().map_err(|e| e.to_string())?;
        if entries.contains_key(&id) {
            return Err("Reef request already exists.".into());
        }
        entries.insert(id.clone(), lease.clone());
    }
    if let Err(error) = std::thread::Builder::new()
        .name("reef-admission".into())
        .spawn(move || {
            if let Err(error) = acquire(&lease, &kind) {
                if let Ok(mut lease) = lease.lock() {
                    if !lease.cancelled {
                        lease.status =
                            status("failed", format!("Reef admission unavailable: {error}"));
                    }
                }
            }
        })
    {
        leases().lock().map_err(|e| e.to_string())?.remove(&id);
        return Err(error.to_string());
    }
    Ok(())
}

#[tauri::command]
pub fn reef_admission_status(id: String) -> Result<AdmissionStatus, String> {
    let lease = leases()
        .lock()
        .map_err(|e| e.to_string())?
        .get(&id)
        .cloned()
        .ok_or("Reef admission request no longer exists.")?;
    let result = lease.lock().map_err(|e| e.to_string())?.status.clone();
    Ok(result)
}

#[tauri::command]
pub fn reef_admission_release(id: String) -> Result<(), String> {
    let Some(lease) = leases().lock().map_err(|e| e.to_string())?.remove(&id) else {
        return Ok(());
    };
    let mut lease = lease.lock().map_err(|e| e.to_string())?;
    lease.cancelled = true;
    #[cfg(unix)]
    if let Some(mut stream) = lease.stream.take() {
        use std::io::Write;
        if lease.status.state == "granted" {
            let _ = stream.write_all(b"done success\n");
        }
        let _ = stream.shutdown(std::net::Shutdown::Both);
    }
    Ok(())
}

#[cfg(unix)]
#[derive(Deserialize)]
struct Protocol {
    version: u32,
    socket: std::path::PathBuf,
}

#[cfg(unix)]
fn discover() -> Result<Protocol, String> {
    use std::io::Read;
    use std::process::{Command, Stdio};
    use std::time::{Duration, Instant};
    let reef = crate::acp::find_executable("reef")
        .ok_or("reef was not found on PATH; install Reef with external admission v1 support.")?;
    let mut child = Command::new(reef)
        .arg("admission-protocol")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| e.to_string())?;
    let deadline = Instant::now() + Duration::from_secs(2);
    loop {
        match child.try_wait() {
            Ok(Some(result)) => {
                if !result.success() {
                    return Err("start `reef serve` and use a Reef version supporting external admission v1.".into());
                }
                let mut output = Vec::new();
                child
                    .stdout
                    .take()
                    .ok_or("Reef discovery returned no output.")?
                    .take(4097)
                    .read_to_end(&mut output)
                    .map_err(|e| e.to_string())?;
                if output.len() > 4096 {
                    return Err("Reef discovery response is too large.".into());
                }
                let protocol: Protocol = serde_json::from_slice(&output)
                    .map_err(|e| format!("Invalid Reef discovery: {e}"))?;
                if protocol.version != 1 || !protocol.socket.is_absolute() {
                    return Err(
                        "Reef external admission protocol is incompatible; version 1 is required."
                            .into(),
                    );
                }
                return Ok(protocol);
            }
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(20)),
            outcome => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(match outcome {
                    Err(error) => error.to_string(),
                    _ => "Reef scheduler discovery timed out.".into(),
                });
            }
        }
    }
}

#[cfg(unix)]
fn acquire(lease: &Arc<Mutex<Lease>>, kind: &str) -> Result<(), String> {
    use std::os::unix::net::UnixStream;
    let protocol = discover()?;
    let stream = UnixStream::connect(protocol.socket).map_err(|e| e.to_string())?;
    acquire_stream(lease, kind, stream)
}

#[cfg(unix)]
fn acquire_stream(
    lease: &Arc<Mutex<Lease>>,
    kind: &str,
    mut stream: std::os::unix::net::UnixStream,
) -> Result<(), String> {
    use std::io::{Read, Write};
    use std::time::{Duration, Instant};
    stream
        .set_read_timeout(Some(Duration::from_millis(250)))
        .map_err(|e| e.to_string())?;
    stream
        .set_write_timeout(Some(Duration::from_secs(2)))
        .map_err(|e| e.to_string())?;
    {
        let mut lease = lease.lock().map_err(|e| e.to_string())?;
        if lease.cancelled {
            return Ok(());
        }
        lease.stream = Some(stream.try_clone().map_err(|e| e.to_string())?);
    }
    let request = serde_json::json!({"op":"acquire", "cpu":1, "memory_mib":if kind == "agent" {1024} else {512}, "identity":format!("sail-{kind}")});
    writeln!(stream, "{request}").map_err(|e| e.to_string())?;
    let mut buffer = Vec::new();
    let mut request_id = None;
    let response_deadline = Instant::now() + Duration::from_secs(2);
    loop {
        if lease.lock().map_err(|e| e.to_string())?.cancelled {
            return Ok(());
        }
        if request_id.is_none() && Instant::now() >= response_deadline {
            return Err("Reef scheduler did not acknowledge admission.".into());
        }
        let mut byte = [0];
        match stream.read(&mut byte) {
            Ok(0) => return Err("Reef scheduler disconnected before admission.".into()),
            Ok(_) if byte[0] == b'\n' => {
                let reply: serde_json::Value =
                    serde_json::from_slice(&buffer).map_err(|e| e.to_string())?;
                buffer.clear();
                let mut lease = lease.lock().map_err(|e| e.to_string())?;
                if lease.cancelled {
                    return Ok(());
                }
                let id = reply["id"].as_u64();
                match reply["kind"].as_str() {
                    Some("queued") if request_id.is_none() && id.is_some() => {
                        request_id = id;
                        lease.status = status(
                            "queued",
                            reply["reason"]
                                .as_str()
                                .ok_or("Reef omitted its queue reason.")?,
                        );
                    }
                    Some("waiting") if id.is_some() && id == request_id => {
                        lease.status = status(
                            "queued",
                            reply["reason"]
                                .as_str()
                                .ok_or("Reef omitted its queue reason.")?,
                        );
                    }
                    Some("granted") if id.is_some() && id == request_id => {
                        lease.status = status("granted", "");
                        return Ok(());
                    }
                    Some("error") => {
                        return Err(reply["message"]
                            .as_str()
                            .unwrap_or("Reef rejected admission.")
                            .into())
                    }
                    Some("cancelled") => return Err("Reef cancelled the queued request.".into()),
                    _ => return Err("Invalid Reef admission response.".into()),
                }
            }
            Ok(_) => {
                if buffer.len() >= 4096 {
                    return Err("Reef admission response is too large.".into());
                }
                buffer.push(byte[0]);
            }
            Err(error)
                if matches!(
                    error.kind(),
                    std::io::ErrorKind::TimedOut | std::io::ErrorKind::WouldBlock
                ) => {}
            Err(error) => return Err(error.to_string()),
        }
    }
}

#[cfg(not(unix))]
fn acquire(_lease: &Arc<Mutex<Lease>>, _kind: &str) -> Result<(), String> {
    Err("Reef admission is supported only on macOS and Linux.".into())
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::io::{BufRead, BufReader, Read, Write};
    use std::os::unix::net::UnixStream;
    use std::time::Duration;

    fn lease() -> Arc<Mutex<Lease>> {
        Arc::new(Mutex::new(Lease {
            status: status("checking", "Checking Reef admission…"),
            cancelled: false,
            stream: None,
        }))
    }

    #[test]
    fn waits_for_matching_grant_and_releases_without_process_ownership() {
        let (client, server) = UnixStream::pair().unwrap();
        server
            .set_read_timeout(Some(Duration::from_secs(3)))
            .unwrap();
        let lease = lease();
        let worker_lease = lease.clone();
        let worker = std::thread::spawn(move || acquire_stream(&worker_lease, "browser", client));
        let mut server = BufReader::new(server);
        let mut request = String::new();
        server.read_line(&mut request).unwrap();
        let request: serde_json::Value = serde_json::from_str(&request).unwrap();
        assert_eq!(request["identity"], "sail-browser");
        assert_eq!(request["memory_mib"], 512);
        writeln!(
            server.get_mut(),
            "{{\"kind\":\"queued\",\"id\":7,\"reason\":\"CPU budget in use\"}}"
        )
        .unwrap();
        writeln!(
            server.get_mut(),
            "{{\"kind\":\"waiting\",\"id\":7,\"reason\":\"memory budget in use\"}}"
        )
        .unwrap();
        writeln!(server.get_mut(), "{{\"kind\":\"granted\",\"id\":7}}").unwrap();
        worker.join().unwrap().unwrap();
        assert_eq!(lease.lock().unwrap().status.state, "granted");
        let id = "reef-test-release".to_string();
        leases().lock().unwrap().insert(id.clone(), lease);
        reef_admission_release(id.clone()).unwrap();
        reef_admission_release(id).unwrap();
        let mut release = String::new();
        server.read_to_string(&mut release).unwrap();
        assert_eq!(release, "done success\n");
    }

    #[test]
    fn malformed_or_wrong_id_replies_never_admit_work() {
        for reply in [
            "not json\n",
            "{\"kind\":\"granted\",\"id\":7}\n",
            "{\"kind\":\"queued\",\"id\":7,\"reason\":\"waiting\"}\n{\"kind\":\"granted\",\"id\":8}\n",
            "{\"kind\":\"queued\",\"id\":7}\n",
        ] {
            let (client, mut server) = UnixStream::pair().unwrap();
            server.write_all(reply.as_bytes()).unwrap();
            let lease = lease();
            assert!(acquire_stream(&lease, "agent", client).is_err());
            assert_ne!(lease.lock().unwrap().status.state, "granted");
        }
    }

    #[test]
    fn cancellation_before_connection_never_submits_work() {
        let (client, mut server) = UnixStream::pair().unwrap();
        let lease = lease();
        lease.lock().unwrap().cancelled = true;
        acquire_stream(&lease, "agent", client).unwrap();
        let mut output = String::new();
        server.read_to_string(&mut output).unwrap();
        assert!(output.is_empty());
    }
}
