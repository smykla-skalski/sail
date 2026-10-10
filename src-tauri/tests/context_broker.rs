#[path = "../src/context_broker.rs"]
mod context_broker;

use context_broker::{
    exact_section, search_response, BrokerError, BrokerLimits, RawHit, SourceBatch,
};

fn hit(id: &str, content: &[u8]) -> RawHit {
    RawHit {
        id: id.into(),
        revision: "revision-1".into(),
        timestamp_ms: 1_728_000_000_000,
        content: content.into(),
    }
}

fn batch(provider: &str, source: &str, result: Result<Vec<RawHit>, ()>) -> SourceBatch {
    SourceBatch {
        provider: provider.into(),
        source: source.into(),
        result,
    }
}

#[test]
fn search_keeps_full_content_out_of_the_response() {
    let secret = b"first line\nSECRET_THAT_MUST_NOT_APPEAR";
    let limits = BrokerLimits {
        preview_bytes: 10,
        ..BrokerLimits::default()
    };
    let response = search_response(
        vec![batch("provider", "source", Ok(vec![hit("one", secret)]))],
        limits,
    )
    .unwrap();
    let encoded = serde_json::to_string(&response).unwrap();
    assert_eq!(response.hits[0].preview, "first line");
    assert_eq!(response.hits[0].total_bytes, secret.len());
    assert_eq!(response.hits[0].sha256.len(), 64);
    assert!(!encoded.contains("SECRET"));
    assert_eq!(response.hits[0].provider, "provider");
    assert_eq!(response.hits[0].source, "source");
    assert_eq!(response.hits[0].revision, "revision-1");
    assert_eq!(response.hits[0].timestamp_ms, 1_728_000_000_000);
}

#[test]
fn search_limits_items_and_bytes_across_sources() {
    let limits = BrokerLimits {
        items: 2,
        preview_bytes: 5,
        response_bytes: 350,
        ..BrokerLimits::default()
    };
    let response = search_response(
        vec![
            batch(
                "one",
                "a",
                Ok(vec![hit("1", b"abcdef"), hit("2", b"ghijkl")]),
            ),
            batch("two", "b", Ok(vec![hit("3", b"mnopqr")])),
        ],
        limits,
    )
    .unwrap();
    assert_eq!(response.hits.len(), 1);
    assert_eq!(response.hits[0].preview, "abcde");
    assert!(response.truncated);
    assert!(serde_json::to_vec(&response).unwrap().len() <= 350);
}

#[test]
fn one_source_failure_does_not_hide_healthy_results_or_leak_errors() {
    let response = search_response(
        vec![
            batch("failed", "a", Err(())),
            batch("healthy", "b", Ok(vec![hit("ok", b"visible")])),
            batch("bad", "c", Ok(vec![hit("invalid\nidentifier", b"secret")])),
        ],
        BrokerLimits::default(),
    )
    .unwrap();
    assert_eq!(response.hits.len(), 1);
    assert_eq!(response.hits[0].provider, "healthy");
    assert_eq!(response.errors.len(), 2);
    assert!(response
        .errors
        .iter()
        .all(|error| error.message == "Source unavailable."));
    assert!(!serde_json::to_string(&response).unwrap().contains("secret"));
}

#[test]
fn malformed_source_identity_does_not_disable_valid_unicode_source() {
    let response = search_response(
        vec![
            batch("bad\nprovider", "a", Ok(vec![hit("bad", b"private")])),
            batch("provider", "źródło", Ok(vec![hit("valid", b"visible")])),
        ],
        BrokerLimits::default(),
    )
    .unwrap();
    assert_eq!(response.hits.len(), 1);
    assert_eq!(response.hits[0].source, "źródło");
    assert!(response.truncated);
    assert!(!serde_json::to_string(&response)
        .unwrap()
        .contains("private"));
}

#[test]
fn many_failed_sources_cannot_starve_a_healthy_hit() {
    let mut batches = (0..50)
        .map(|index| batch("failed", &format!("{index:02}{}", "s".repeat(10)), Err(())))
        .collect::<Vec<_>>();
    batches.push(batch("healthy", "source", Ok(vec![hit("ok", b"found")])));
    let response = search_response(batches, BrokerLimits::default()).unwrap();
    assert_eq!(response.hits.len(), 1);
    assert_eq!(response.hits[0].id, "ok");
    assert!(!response.errors.is_empty());
    assert!(response.truncated);
    assert!(serde_json::to_vec(&response).unwrap().len() <= 4 * 1024);
}

#[test]
fn preview_remains_within_byte_limit_for_invalid_utf8() {
    let content = [0xff, 0xfe, b'a'];
    let limits = BrokerLimits {
        preview_bytes: 2,
        ..BrokerLimits::default()
    };
    let response =
        search_response(vec![batch("p", "s", Ok(vec![hit("i", &content)]))], limits).unwrap();
    assert!(response.hits[0].preview.len() <= 2);
}

#[test]
fn exact_read_enforces_range_and_returns_unchanged_bytes() {
    let content = [0, 255, 1, 2, 3];
    let limits = BrokerLimits {
        read_bytes: 3,
        ..BrokerLimits::default()
    };
    let section = exact_section(&content, 1, 3, limits).unwrap();
    assert_eq!(section.bytes, [255, 1, 2]);
    assert_eq!(section.offset, 1);
    assert_eq!(section.total_bytes, 5);
    assert_eq!(section.sha256.len(), 64);
    assert_eq!(
        exact_section(&content, 1, 4, limits),
        Err(BrokerError::ReadLimitExceeded)
    );
    assert_eq!(
        exact_section(&content, usize::MAX, 1, limits),
        Err(BrokerError::RangeUnavailable)
    );
}

#[test]
fn invalid_limits_are_rejected() {
    assert_eq!(
        search_response(
            Vec::new(),
            BrokerLimits {
                items: 0,
                ..BrokerLimits::default()
            }
        ),
        Err(BrokerError::InvalidLimits)
    );
}
