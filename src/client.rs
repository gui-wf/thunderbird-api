use anyhow::{Context, Result};
use serde_json::Value;
use std::time::Duration;

use crate::sanitize::sanitize_json;
use crate::types::{JsonRpcRequest, JsonRpcResponse};

const THUNDERBIRD_PORT: u16 = 8765;
const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);

pub struct ThunderbirdClient {
    agent: ureq::Agent,
    url: String,
}

impl Default for ThunderbirdClient {
    fn default() -> Self {
        Self::new()
    }
}

impl ThunderbirdClient {
    pub fn new() -> Self {
        let agent = ureq::Agent::new_with_config(
            ureq::config::Config::builder()
                .http_status_as_error(false)
                .timeout_global(Some(REQUEST_TIMEOUT))
                .build(),
        );
        Self {
            agent,
            url: format!("http://localhost:{}/", THUNDERBIRD_PORT),
        }
    }

    /// Send a raw JSON-RPC request and return the parsed response.
    /// Uses sanitize_json as fallback if the response contains invalid control chars.
    pub fn send_raw(&self, request: &JsonRpcRequest) -> JsonRpcResponse {
        let body = match serde_json::to_string(request) {
            Ok(b) => b,
            Err(e) => {
                return JsonRpcResponse::error(
                    request.id.clone(),
                    -32700,
                    format!("Failed to serialize request: {}", e),
                );
            }
        };

        let response = match self
            .agent
            .post(&self.url)
            .content_type("application/json")
            .send(&body)
        {
            Ok(r) => r,
            Err(e) => {
                return JsonRpcResponse::error(
                    request.id.clone(),
                    -32603,
                    format!(
                        "Connection failed: {}. Is Thunderbird running with the MCP extension?",
                        e
                    ),
                );
            }
        };

        let data = match response.into_body().read_to_string() {
            Ok(d) => d,
            Err(e) => {
                return JsonRpcResponse::error(
                    request.id.clone(),
                    -32603,
                    format!("Failed to read response body: {}", e),
                );
            }
        };

        // Try parsing as-is, then with sanitization as fallback
        match serde_json::from_str::<JsonRpcResponse>(&data) {
            Ok(resp) => resp,
            Err(_) => {
                let sanitized = sanitize_json(&data);
                match serde_json::from_str::<JsonRpcResponse>(&sanitized) {
                    Ok(resp) => resp,
                    Err(e) => JsonRpcResponse::error(
                        request.id.clone(),
                        -32700,
                        format!("Invalid JSON from Thunderbird: {}", e),
                    ),
                }
            }
        }
    }

    /// Call an MCP tool and return the parsed result value.
    /// Unwraps the MCP content block structure and parses the inner JSON text.
    pub fn call_tool(&self, name: &str, args: Value) -> Result<Value> {
        let request = JsonRpcRequest {
            jsonrpc: "2.0".into(),
            id: Some(Value::Number(1.into())),
            method: "tools/call".into(),
            params: Some(serde_json::json!({
                "name": name,
                "arguments": args,
            })),
        };

        let response = self.send_raw(&request);

        if let Some(err) = response.error {
            anyhow::bail!("{}", err.message);
        }

        let result = response
            .result
            .context("No result in response")?;

        // MCP wraps tool results in content blocks
        if let Some(content) = result.get("content").and_then(|c| c.as_array()) {
            if let Some(text_block) = content.iter().find(|b| b.get("type") == Some(&Value::String("text".into()))) {
                if let Some(text) = text_block.get("text").and_then(|t| t.as_str()) {
                    // Parse inner JSON with sanitize fallback
                    return match serde_json::from_str::<Value>(text) {
                        Ok(v) => Ok(v),
                        Err(_) => {
                            let sanitized = sanitize_json(text);
                            serde_json::from_str::<Value>(&sanitized)
                                .or_else(|_| {
                                    // Not valid JSON - return as raw string value
                                    Ok(Value::String(text.to_string()))
                                })
                        }
                    };
                }
            }
        }

        Ok(result)
    }
}
