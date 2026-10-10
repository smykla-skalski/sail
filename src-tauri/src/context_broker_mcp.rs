use crate::context_broker::{search_response, BrokerLimits, RawHit, SourceBatch};
use crate::context_output_store::{OutputScope, OutputStore};
use base64::Engine;
use serde_json::{json, Value};

const PROTOCOL_VERSION: &str = "2025-06-18";
const PAGE_BYTES: usize = 1024;

pub struct BrokerMcp {
    provider: String,
    scope: OutputScope,
    store: OutputStore,
    limits: BrokerLimits,
}

impl BrokerMcp {
    pub fn new(provider: String, scope: OutputScope, store: OutputStore) -> Self {
        Self {
            provider,
            scope,
            store,
            limits: BrokerLimits::default(),
        }
    }

    pub fn handle(
        &self,
        input: &str,
        mut provider_call: impl FnMut(&str, Value) -> Result<Value, ()>,
    ) -> Option<Value> {
        let request: Value = match serde_json::from_str(input) {
            Ok(request) => request,
            Err(_) => return Some(rpc_error(Value::Null, -32700, "Invalid JSON.")),
        };
        let id = request.get("id").cloned();
        let Some(method) = request.get("method").and_then(Value::as_str) else {
            return Some(rpc_error(
                id.unwrap_or(Value::Null),
                -32600,
                "Invalid request.",
            ));
        };
        if request.get("jsonrpc").and_then(Value::as_str) != Some("2.0") {
            return Some(rpc_error(
                id.unwrap_or(Value::Null),
                -32600,
                "Invalid request.",
            ));
        }
        let id = id?;
        let result = match method {
            "initialize" => json!({
                "protocolVersion": PROTOCOL_VERSION,
                "capabilities": {"tools": {}},
                "serverInfo": {"name": "sail-context", "version": env!("CARGO_PKG_VERSION")}
            }),
            "ping" => json!({}),
            "tools/list" => tool_catalog(),
            "tools/call" => {
                let Some(name) = request.pointer("/params/name").and_then(Value::as_str) else {
                    return Some(rpc_error(id, -32602, "Tool name is required."));
                };
                let arguments = request
                    .pointer("/params/arguments")
                    .cloned()
                    .unwrap_or_else(|| json!({}));
                self.call(name, &arguments, &mut provider_call)
            }
            _ => return Some(rpc_error(id, -32601, "Method unavailable.")),
        };
        Some(json!({"jsonrpc":"2.0","id":id,"result":result}))
    }

    fn call(
        &self,
        name: &str,
        arguments: &Value,
        provider_call: &mut impl FnMut(&str, Value) -> Result<Value, ()>,
    ) -> Value {
        let outcome = match name {
            "sail_context_sources" => self.sources(provider_call),
            "sail_context_search" => self.search(arguments, provider_call),
            "sail_context_get" => self.get(arguments, provider_call),
            "sail_context_health" => self.health(provider_call),
            _ => Err("Context tool is unavailable."),
        };
        match outcome {
            Ok(value) => tool_result(value, false),
            Err(message) => tool_result(
                json!({"provider":self.provider,"source":self.provider,"error":message}),
                true,
            ),
        }
    }

    fn available_tools(
        &self,
        provider_call: &mut impl FnMut(&str, Value) -> Result<Value, ()>,
    ) -> Result<Vec<String>, &'static str> {
        let mut names = Vec::new();
        let mut cursor = None::<String>;
        let mut seen = std::collections::HashSet::new();
        for _ in 0..16 {
            let arguments = cursor
                .as_ref()
                .map_or_else(|| json!({}), |cursor| json!({"cursor":cursor}));
            let response = provider_call("tools/list", arguments)
                .map_err(|_| "Provider source unavailable.")?;
            let tools = response
                .pointer("/result/tools")
                .and_then(Value::as_array)
                .ok_or("Provider source unavailable.")?;
            if names.len() + tools.len() > 128 {
                return Err("Provider source unavailable.");
            }
            for tool in tools {
                let name = tool
                    .get("name")
                    .and_then(Value::as_str)
                    .filter(|name| !name.is_empty() && name.len() <= 128)
                    .ok_or("Provider source unavailable.")?;
                names.push(name.to_owned());
            }
            cursor = response
                .pointer("/result/nextCursor")
                .and_then(Value::as_str)
                .map(str::to_owned);
            match &cursor {
                None => return Ok(names),
                Some(cursor)
                    if cursor.is_empty() || cursor.len() > 256 || !seen.insert(cursor.clone()) =>
                {
                    return Err("Provider source unavailable.");
                }
                Some(_) => {}
            }
        }
        Err("Provider source unavailable.")
    }

    fn sources(
        &self,
        provider_call: &mut impl FnMut(&str, Value) -> Result<Value, ()>,
    ) -> Result<Value, &'static str> {
        let names = self.available_tools(provider_call)?;
        Ok(json!({
            "sources": [{"provider": self.provider, "source": self.provider,
                "search": names.iter().any(|name| name == "search"),
                "get": names.iter().any(|name| name == "get")}]
        }))
    }

    fn health(
        &self,
        provider_call: &mut impl FnMut(&str, Value) -> Result<Value, ()>,
    ) -> Result<Value, &'static str> {
        let names = self.available_tools(provider_call)?;
        Ok(json!({
            "provider": self.provider,
            "state": if names.iter().any(|name| name == "search")
                && names.iter().any(|name| name == "get") {"ready"} else {"missing-tools"}
        }))
    }

    fn search(
        &self,
        arguments: &Value,
        provider_call: &mut impl FnMut(&str, Value) -> Result<Value, ()>,
    ) -> Result<Value, &'static str> {
        let query = arguments
            .get("query")
            .and_then(Value::as_str)
            .filter(|query| !query.is_empty() && query.len() <= 1024)
            .ok_or("Search query is invalid.")?;
        let names = self.available_tools(provider_call)?;
        if !names.iter().any(|name| name == "search") {
            return Err("Provider search is unavailable.");
        }
        let response = provider_call(
            "tools/call",
            json!({"name":"search","arguments":{"query":query,"limit":self.limits.items}}),
        )
        .map_err(|_| "Provider source unavailable.")?;
        let items = result_content(&response)?
            .get("items")
            .and_then(Value::as_array)
            .ok_or("Provider source unavailable.")?;
        if items.len() > 128 {
            return Err("Provider source unavailable.");
        }
        let mut batches = Vec::with_capacity(items.len());
        for item in items {
            let source = item
                .get("sourceUri")
                .and_then(Value::as_str)
                .filter(|source| {
                    !source.is_empty()
                        && source.len() <= 256
                        && !source.chars().any(char::is_control)
                })
                .unwrap_or(&self.provider);
            batches.push(SourceBatch {
                provider: self.provider.clone(),
                source: source.to_owned(),
                result: parse_hit(item).map(|hit| vec![hit]).map_err(|_| ()),
            });
        }
        let mut result =
            search_response(batches, self.limits).map_err(|_| "Search limits are invalid.")?;
        loop {
            let value =
                serde_json::to_value(&result).map_err(|_| "Provider source unavailable.")?;
            if serde_json::to_vec(&tool_result(value.clone(), false))
                .is_ok_and(|encoded| encoded.len() <= self.limits.response_bytes)
            {
                return Ok(value);
            }
            result.truncated = true;
            if let Some(hit) = result.hits.last_mut() {
                if !hit.preview.is_empty() {
                    hit.preview.pop();
                } else {
                    result.hits.pop();
                }
            } else if result.errors.pop().is_none() {
                return Err("Search response limit is too small.");
            }
        }
    }

    fn get(
        &self,
        arguments: &Value,
        provider_call: &mut impl FnMut(&str, Value) -> Result<Value, ()>,
    ) -> Result<Value, &'static str> {
        let offset = match arguments.get("offset") {
            Some(value) => value.as_u64().ok_or("Read offset is invalid.")?,
            None => 0,
        };
        let length = match arguments.get("length") {
            Some(value) => value.as_u64().ok_or("Read length is invalid.")?,
            None => PAGE_BYTES as u64,
        };
        let length = usize::try_from(length).map_err(|_| "Read length is invalid.")?;
        if length == 0 || length > PAGE_BYTES {
            return Err("Read length is invalid.");
        }
        if let Some(reference) = arguments.get("reference").and_then(Value::as_str) {
            if arguments.get("id").is_some() {
                return Err("Choose an ID or a reference.");
            }
            return self.read(reference, offset, length);
        }
        if offset != 0 {
            return Err("Read an ID from offset zero.");
        }
        let id = arguments
            .get("id")
            .and_then(Value::as_str)
            .filter(|id| !id.is_empty() && id.len() <= 256)
            .ok_or("Result ID is invalid.")?;
        let names = self.available_tools(provider_call)?;
        if !names.iter().any(|name| name == "get") {
            return Err("Provider get is unavailable.");
        }
        let response = provider_call("tools/call", json!({"name":"get","arguments":{"id":id}}))
            .map_err(|_| "Provider source unavailable.")?;
        let content = result_content(&response)?;
        let hit = parse_hit(content)?;
        if hit.id != id {
            return Err("Provider source unavailable.");
        }
        let source = content
            .get("sourceUri")
            .and_then(Value::as_str)
            .ok_or("Provider source unavailable.")?;
        if source.len() > 256 || source.is_empty() {
            return Err("Provider source unavailable.");
        }
        let stored = self
            .store
            .put(&self.scope, &hit.content)
            .map_err(|warning| warning.message())?;
        let section = self.read(&stored.reference, 0, length)?;
        Ok(json!({
            "id": id,
            "provider": self.provider,
            "source": source,
            "revision": hit.revision,
            "timestampMs": hit.timestamp_ms,
            "sha256": stored.sha256,
            "summary": stored.summary,
            "section": section
        }))
    }

    fn read(&self, reference: &str, offset: u64, length: usize) -> Result<Value, &'static str> {
        let section = self
            .store
            .read_range(&self.scope, reference, offset, length)
            .map_err(|warning| warning.message())?;
        Ok(json!({
            "reference": reference,
            "offset": section.offset,
            "totalBytes": section.total_bytes,
            "bytesBase64": base64::engine::general_purpose::STANDARD.encode(section.bytes)
        }))
    }
}

fn result_content(response: &Value) -> Result<&Value, &'static str> {
    if response.get("error").is_some()
        || response.pointer("/result/isError").and_then(Value::as_bool) == Some(true)
    {
        return Err("Provider source unavailable.");
    }
    response
        .pointer("/result/structuredContent")
        .ok_or("Provider source unavailable.")
}

fn parse_hit(item: &Value) -> Result<RawHit, &'static str> {
    let field = |name| item.get(name).and_then(Value::as_str);
    let id = field("id").ok_or("Provider source unavailable.")?;
    let source = field("sourceUri").ok_or("Provider source unavailable.")?;
    let revision = field("revision").ok_or("Provider source unavailable.")?;
    let timestamp_ms = item
        .get("timestampMs")
        .and_then(Value::as_u64)
        .ok_or("Provider source unavailable.")?;
    let content = field("content").ok_or("Provider source unavailable.")?;
    if id.is_empty()
        || id.len() > 256
        || source.is_empty()
        || source.len() > 256
        || revision.is_empty()
        || revision.len() > 128
        || timestamp_ms == 0
        || content.len() > 16 * 1024 * 1024
        || [id, source, revision]
            .iter()
            .any(|field| field.chars().any(char::is_control))
    {
        return Err("Provider source unavailable.");
    }
    Ok(RawHit {
        id: id.to_owned(),
        revision: revision.to_owned(),
        timestamp_ms,
        content: content.as_bytes().to_vec(),
    })
}

fn tool_result(value: Value, is_error: bool) -> Value {
    json!({"content":[{"type":"text","text":value.to_string()}],"isError":is_error})
}

fn rpc_error(id: Value, code: i64, message: &str) -> Value {
    json!({"jsonrpc":"2.0","id":id,"error":{"code":code,"message":message}})
}

fn tool_catalog() -> Value {
    json!({"tools":[
        {"name":"sail_context_sources","description":"List approved context sources.","inputSchema":{"type":"object","properties":{}}},
        {"name":"sail_context_search","description":"Search approved context sources.","inputSchema":{"type":"object","properties":{"query":{"type":"string"}},"required":["query"]}},
        {"name":"sail_context_get","description":"Get a result or read an exact stored section.","inputSchema":{"type":"object","properties":{"id":{"type":"string"},"reference":{"type":"string"},"offset":{"type":"integer","minimum":0},"length":{"type":"integer","minimum":1,"maximum":1024}}}},
        {"name":"sail_context_health","description":"Inspect approved context provider health.","inputSchema":{"type":"object","properties":{}}}
    ]})
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::PathBuf;

    struct Fixture {
        root: PathBuf,
        broker: BrokerMcp,
    }

    impl Fixture {
        fn new(session: &str) -> Self {
            let root = std::env::temp_dir().join(format!("sail-broker-{}", uuid::Uuid::new_v4()));
            fs::create_dir(&root).unwrap();
            let scope = OutputScope {
                repository: "repo".into(),
                worktree: "worktree".into(),
                user: "user".into(),
                provider: "provider".into(),
                session: session.into(),
                revision: "trusted-commit".into(),
            };
            let store = OutputStore::open(root.join("output"), Default::default()).unwrap();
            Self {
                root,
                broker: BrokerMcp::new("provider".into(), scope, store),
            }
        }

        fn call(
            &self,
            name: &str,
            arguments: Value,
            mut provider: impl FnMut(&str, Value) -> Result<Value, ()>,
        ) -> (Value, Value) {
            let request = json!({"jsonrpc":"2.0","id":7,"method":"tools/call",
                "params":{"name":name,"arguments":arguments}});
            let response = self
                .broker
                .handle(&request.to_string(), &mut provider)
                .unwrap();
            let text = response["result"]["content"][0]["text"].as_str().unwrap();
            (response.clone(), serde_json::from_str(text).unwrap())
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            fs::remove_dir_all(&self.root).unwrap();
        }
    }

    fn available() -> Value {
        json!({"result":{"tools":[{"name":"search"},{"name":"get"},
            {"name":"secret_admin_tool"}]}})
    }

    fn item(id: &str, content: &str) -> Value {
        json!({"id":id,"sourceUri":"file:///project/notes", "revision":"r1",
            "timestampMs":1760122800000_u64,"content":content})
    }

    #[test]
    fn tools_are_stable_and_provider_catalog_stays_hidden() {
        let fixture = Fixture::new("one");
        let response = fixture
            .broker
            .handle(
                r#"{"jsonrpc":"2.0","id":1,"method":"tools/list"}"#,
                |_, _| panic!("agent catalog must not query the provider"),
            )
            .unwrap();
        let names: Vec<&str> = response["result"]["tools"]
            .as_array()
            .unwrap()
            .iter()
            .map(|tool| tool["name"].as_str().unwrap())
            .collect();
        assert_eq!(names.len(), 4);
        assert!(!names.contains(&"secret_admin_tool"));
        let (_, sources) = fixture.call("sail_context_sources", json!({}), |method, _| {
            assert_eq!(method, "tools/list");
            Ok(available())
        });
        assert_eq!(sources["sources"][0]["provider"], "provider");
        assert_eq!(sources["sources"][0]["search"], true);
    }

    #[test]
    fn paginated_provider_catalog_finds_broker_tools() {
        let fixture = Fixture::new("one");
        let (_, health) = fixture.call("sail_context_health", json!({}), |method, params| {
            assert_eq!(method, "tools/list");
            if params.get("cursor").is_some() {
                Ok(json!({"result":{"tools":[{"name":"search"},{"name":"get"}]}}))
            } else {
                Ok(json!({"result":{"tools":[{"name":"other"}],"nextCursor":"page-2"}}))
            }
        });
        assert_eq!(health["state"], "ready");
        let (_, error) = fixture.call(
            "sail_context_get",
            json!({"reference":"x","offset":-1}),
            |_, _| panic!("malformed local read must not call provider"),
        );
        assert_eq!(error["error"], "Read offset is invalid.");
    }

    #[test]
    fn search_keeps_healthy_sources_and_bounds_agent_result() {
        let fixture = Fixture::new("one");
        let mut items = vec![json!({"id":"broken","sourceUri":"file:///broken"})];
        for index in 0..40 {
            items.push(item(&format!("hit-{index}"), &"x".repeat(700)));
        }
        let (response, body) = fixture.call(
            "sail_context_search",
            json!({"query":"needle"}),
            |method, params| {
                if method == "tools/list" {
                    return Ok(available());
                }
                assert_eq!(params["name"], "search");
                assert_eq!(params["arguments"]["query"], "needle");
                Ok(json!({"result":{"structuredContent":{"items":items}}}))
            },
        );
        assert!(serde_json::to_vec(&response["result"]).unwrap().len() <= 4096);
        assert!(body["hits"].as_array().unwrap().len() <= 8);
        assert!(body["hits"].as_array().unwrap().len() >= 1);
        assert_eq!(body["hits"][0]["provider"], "provider");
        assert_eq!(body["hits"][0]["source"], "file:///project/notes");
        assert_eq!(body["hits"][0]["revision"], "r1");
        assert!(body["hits"][0]["sha256"].as_str().unwrap().len() == 64);
        assert_eq!(body["errors"][0]["source"], "file:///broken");
        assert_eq!(body["truncated"], true);
    }

    #[test]
    fn get_stores_full_result_and_reads_exact_scoped_bytes() {
        let fixture = Fixture::new("one");
        let content = "a".repeat(3000);
        let (_, body) = fixture.call("sail_context_get", json!({"id":"doc"}), |method, params| {
            if method == "tools/list" {
                return Ok(available());
            }
            assert_eq!(params["name"], "get");
            assert_eq!(params["arguments"]["id"], "doc");
            Ok(json!({"result":{"structuredContent":item("doc", &content)}}))
        });
        let reference = body["section"]["reference"].as_str().unwrap();
        assert_eq!(body["sha256"].as_str().unwrap().len(), 64);
        assert_eq!(body["section"]["totalBytes"], 3000);
        let decoded = base64::engine::general_purpose::STANDARD
            .decode(body["section"]["bytesBase64"].as_str().unwrap())
            .unwrap();
        assert_eq!(decoded, vec![b'a'; 1024]);
        let (_, next) = fixture.call(
            "sail_context_get",
            json!({"reference":reference,"offset":1024,"length":1000}),
            |_, _| panic!("reference read must remain local"),
        );
        let decoded = base64::engine::general_purpose::STANDARD
            .decode(next["bytesBase64"].as_str().unwrap())
            .unwrap();
        assert_eq!(decoded, vec![b'a'; 1000]);
        let other_scope = OutputScope {
            session: "another".into(),
            ..fixture.broker.scope.clone()
        };
        let other = BrokerMcp::new("provider".into(), other_scope, fixture.broker.store.clone());
        assert_eq!(
            other.read(reference, 0, 100).unwrap_err(),
            "Output is unavailable in this scope."
        );
    }

    #[test]
    fn malformed_provider_and_storage_failures_are_bounded() {
        let fixture = Fixture::new("one");
        let (response, body) = fixture.call("sail_context_get", json!({"id":"doc"}), |method, _| {
            if method == "tools/list" {
                return Ok(available());
            }
            Ok(json!({"result":{"isError":true,"content":[{"type":"text","text":"private secret"}]}}))
        });
        assert_eq!(response["result"]["isError"], true);
        assert_eq!(body["provider"], "provider");
        assert_eq!(body["source"], "provider");
        assert!(!response.to_string().contains("private secret"));
        let (response, _) = fixture.call(
            "sail_context_get",
            json!({"reference":"out:v1:bad","length":2048}),
            |_, _| panic!("invalid read must not call provider"),
        );
        assert_eq!(response["result"]["isError"], true);
        assert!(serde_json::to_vec(&response).unwrap().len() < 512);
        fs::remove_dir_all(fixture.root.join("output")).unwrap();
        fs::write(fixture.root.join("output"), b"blocked").unwrap();
        let (_, body) = fixture.call("sail_context_get", json!({"id":"doc"}), |method, _| {
            if method == "tools/list" {
                return Ok(available());
            }
            Ok(json!({"result":{"structuredContent":item("doc", "private secret")}}))
        });
        assert_eq!(body["error"], "Output storage is unavailable.");
        assert!(!body.to_string().contains("private secret"));
    }
}
