use serde_json::{json, Value};
use std::io::{self, BufRead, Write};

use thunderbird_api::client::ThunderbirdClient;
use thunderbird_api::types::{JsonRpcRequest, JsonRpcResponse};

fn handle_locally(request: &JsonRpcRequest) -> Option<Option<JsonRpcResponse>> {
    match request.method.as_str() {
        "initialize" => Some(Some(JsonRpcResponse::success(
            request.id.clone(),
            json!({
                "protocolVersion": "2024-11-05",
                "capabilities": { "tools": {} },
                "serverInfo": { "name": "thunderbird-api", "version": "0.3.0" }
            }),
        ))),

        "resources/list" => Some(Some(JsonRpcResponse::success(
            request.id.clone(),
            json!({ "resources": [] }),
        ))),

        "prompts/list" => Some(Some(JsonRpcResponse::success(
            request.id.clone(),
            json!({ "prompts": [] }),
        ))),

        // Notifications produce zero stdout
        m if m.starts_with("notifications/") => Some(None),

        _ => None,
    }
}

fn main() {
    let client = ThunderbirdClient::new();
    let stdin = io::stdin();
    let stdout = io::stdout();

    for line in stdin.lock().lines() {
        let line = match line {
            Ok(l) => l,
            Err(e) => {
                eprintln!("thunderbird-api: stdin read error: {}", e);
                break;
            }
        };

        if line.trim().is_empty() {
            continue;
        }

        // Extract the request id before full parse, in case parsing fails
        let raw_id: Option<Value> = serde_json::from_str::<Value>(&line)
            .ok()
            .and_then(|v| v.get("id").cloned());

        let request: JsonRpcRequest = match serde_json::from_str(&line) {
            Ok(r) => r,
            Err(e) => {
                let response = JsonRpcResponse::error(
                    raw_id,
                    -32700,
                    format!("Parse error: {}", e),
                );
                write_response(&stdout, &response);
                continue;
            }
        };

        // Try handling locally first
        if let Some(local_result) = handle_locally(&request) {
            match local_result {
                Some(response) => write_response(&stdout, &response),
                None => {
                    // Notification - produce zero stdout output
                }
            }
            continue;
        }

        // Forward to Thunderbird
        let response = client.send_raw(&request);
        write_response(&stdout, &response);
    }
}

fn write_response(stdout: &io::Stdout, response: &JsonRpcResponse) {
    let mut handle = stdout.lock();
    if let Err(e) = serde_json::to_writer(&mut handle, response) {
        eprintln!("thunderbird-api: failed to write response: {}", e);
        return;
    }
    if let Err(e) = handle.write_all(b"\n") {
        eprintln!("thunderbird-api: failed to write newline: {}", e);
        return;
    }
    if let Err(e) = handle.flush() {
        eprintln!("thunderbird-api: failed to flush stdout: {}", e);
    }
}
