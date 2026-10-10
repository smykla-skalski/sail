use serde::Serialize;
use sha2::{Digest, Sha256};

const MAX_ITEMS: usize = 64;
const MAX_PREVIEW_BYTES: usize = 4 * 1024;
const MAX_RESPONSE_BYTES: usize = 64 * 1024;
const MAX_READ_BYTES: usize = 64 * 1024;
const MAX_CONTENT_BYTES: usize = 16 * 1024 * 1024;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct BrokerLimits {
    pub items: usize,
    pub preview_bytes: usize,
    pub response_bytes: usize,
    pub read_bytes: usize,
}

impl Default for BrokerLimits {
    fn default() -> Self {
        Self {
            items: 8,
            preview_bytes: 512,
            response_bytes: 4 * 1024,
            read_bytes: 32 * 1024,
        }
    }
}

impl BrokerLimits {
    pub fn validate(self) -> Result<Self, BrokerError> {
        if self.items == 0
            || self.items > MAX_ITEMS
            || self.preview_bytes == 0
            || self.preview_bytes > MAX_PREVIEW_BYTES
            || self.response_bytes < 64
            || self.response_bytes > MAX_RESPONSE_BYTES
            || self.read_bytes == 0
            || self.read_bytes > MAX_READ_BYTES
        {
            return Err(BrokerError::InvalidLimits);
        }
        Ok(self)
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum BrokerError {
    InvalidLimits,
    InvalidResult,
    ReadLimitExceeded,
    RangeUnavailable,
}

#[derive(Clone, Debug)]
pub struct RawHit {
    pub id: String,
    pub revision: String,
    pub timestamp_ms: u64,
    pub content: Vec<u8>,
}

#[derive(Clone, Debug)]
pub struct SourceBatch {
    pub provider: String,
    pub source: String,
    pub result: Result<Vec<RawHit>, ()>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchHit {
    pub id: String,
    pub provider: String,
    pub source: String,
    pub revision: String,
    pub timestamp_ms: u64,
    pub sha256: String,
    pub total_bytes: usize,
    pub preview: String,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceError {
    pub provider: String,
    pub source: String,
    pub message: &'static str,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchResponse {
    pub hits: Vec<SearchHit>,
    pub errors: Vec<SourceError>,
    pub truncated: bool,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ExactSection {
    pub bytes: Vec<u8>,
    pub offset: usize,
    pub total_bytes: usize,
    pub sha256: String,
}

fn valid_field(field: &str, max_bytes: usize) -> bool {
    !field.is_empty()
        && field.len() <= max_bytes
        && field.chars().all(|character| !character.is_control())
}

fn valid_batch(batch: &SourceBatch) -> bool {
    valid_field(&batch.provider, 64)
        && valid_field(&batch.source, 256)
        && batch.result.as_ref().is_ok_and(|hits| {
            hits.iter().all(|hit| {
                valid_field(&hit.id, 256)
                    && valid_field(&hit.revision, 128)
                    && hit.timestamp_ms > 0
                    && hit.content.len() <= MAX_CONTENT_BYTES
            })
        })
}

fn sha256(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn preview(bytes: &[u8], limit: usize) -> String {
    let prefix = &bytes[..bytes.len().min(limit)];
    let text = String::from_utf8_lossy(prefix);
    let mut end = 0;
    for (index, character) in text.char_indices() {
        let next = index + character.len_utf8();
        if next > limit {
            break;
        }
        end = next;
    }
    text[..end].to_owned()
}

fn fits(response: &SearchResponse, max_bytes: usize) -> bool {
    serde_json::to_vec(response).is_ok_and(|encoded| encoded.len() <= max_bytes)
}

/// Normalizes trusted source batches before any data reaches an agent response.
pub fn search_response(
    batches: impl IntoIterator<Item = SourceBatch>,
    limits: BrokerLimits,
) -> Result<SearchResponse, BrokerError> {
    let limits = limits.validate()?;
    let mut response = SearchResponse {
        hits: Vec::new(),
        errors: Vec::new(),
        truncated: false,
    };
    for batch in batches {
        if !valid_field(&batch.provider, 64) || !valid_field(&batch.source, 256) {
            response.truncated = true;
            continue;
        }
        if !valid_batch(&batch) {
            response.errors.push(SourceError {
                provider: batch.provider,
                source: batch.source,
                message: "Source unavailable.",
            });
            if !fits(&response, limits.response_bytes) {
                response.errors.pop();
                response.truncated = true;
            }
            continue;
        }
        for hit in batch.result.unwrap_or_default() {
            if response.hits.len() == limits.items {
                response.truncated = true;
                continue;
            }
            response.hits.push(SearchHit {
                id: hit.id,
                provider: batch.provider.clone(),
                source: batch.source.clone(),
                revision: hit.revision,
                timestamp_ms: hit.timestamp_ms,
                sha256: sha256(&hit.content),
                total_bytes: hit.content.len(),
                preview: preview(&hit.content, limits.preview_bytes),
            });
            while !fits(&response, limits.response_bytes)
                && !response.hits.last().unwrap().preview.is_empty()
            {
                response.hits.last_mut().unwrap().preview.pop();
                response.truncated = true;
            }
            if !fits(&response, limits.response_bytes) {
                response.hits.pop();
                response.truncated = true;
            }
        }
    }
    Ok(response)
}

/// Returns exact bytes after applying the broker's independent read ceiling.
pub fn exact_section(
    content: &[u8],
    offset: usize,
    length: usize,
    limits: BrokerLimits,
) -> Result<ExactSection, BrokerError> {
    let limits = limits.validate()?;
    if content.len() > MAX_CONTENT_BYTES {
        return Err(BrokerError::InvalidResult);
    }
    if length == 0 || length > limits.read_bytes {
        return Err(BrokerError::ReadLimitExceeded);
    }
    let end = offset
        .checked_add(length)
        .filter(|end| *end <= content.len())
        .ok_or(BrokerError::RangeUnavailable)?;
    Ok(ExactSection {
        bytes: content[offset..end].to_vec(),
        offset,
        total_bytes: content.len(),
        sha256: sha256(content),
    })
}
