use std::time::Duration;

use anyhow::Result;
use serde_json::{json, Value};

use crate::client::ThunderbirdClient;

use super::format;
use super::{Cli, Command};

/// Per-attachment fetch budget handed to the extension; mirrors its own default.
const DEFAULT_ATTACHMENT_TIMEOUT_MS: u64 = 60_000;

pub fn run(cli: Cli) -> Result<()> {
    let client = ThunderbirdClient::new();

    match cli.command {
        Command::Accounts => {
            let result = client.call_tool("listAccounts", json!({}))?;
            format::print_accounts(&result);
        }

        Command::Search {
            query,
            start_date,
            end_date,
            max,
            sort,
        } => {
            let mut args = json!({ "query": query });
            let obj = args.as_object_mut().unwrap();
            if let Some(sd) = start_date {
                obj.insert("startDate".into(), json!(sd));
            }
            if let Some(ed) = end_date {
                obj.insert("endDate".into(), json!(ed));
            }
            if let Some(m) = max {
                obj.insert("maxResults".into(), json!(m));
            }
            if let Some(s) = sort {
                obj.insert("sortOrder".into(), json!(s));
            }
            let result = client.call_tool("searchMessages", args)?;
            check_error(&result)?;
            // New response shape: { messages: [...], metadata: {...} }
            // Fall back to treating result as array for old extension versions
            let (messages, metadata) = if let Some(msgs) = result.get("messages") {
                (msgs.clone(), result.get("metadata").cloned())
            } else {
                (result.clone(), None)
            };
            format::print_messages(&messages);
            if let Some(meta) = metadata {
                format::print_search_metadata(&meta);
            }
        }

        Command::Get {
            message_id,
            folder_path,
            save_attachments,
            force_large,
            attachment_timeout,
        } => {
            let att_timeout = attachment_timeout.unwrap_or(DEFAULT_ATTACHMENT_TIMEOUT_MS);
            let args = json!({
                "messageId": message_id,
                "folderPath": folder_path,
                "saveAttachments": save_attachments,
                "forceLarge": force_large,
                "attachmentTimeoutMs": att_timeout,
            });
            let result = if save_attachments {
                // Fetching parts that are not yet in the offline store goes over IMAP,
                // which routinely outlives the default 30s HTTP timeout. Outlast the
                // extension's own per-attachment bound so a stalled part comes back as
                // a named deferred attachment rather than an opaque global timeout.
                let http_timeout = Duration::from_millis(att_timeout.saturating_add(30_000));
                ThunderbirdClient::with_timeout(http_timeout).call_tool("getMessage", args)?
            } else {
                client.call_tool("getMessage", args)?
            };
            format::print_message(&result);
        }

        Command::Folders { account } => {
            let mut args = json!({});
            if let Some(a) = account {
                args.as_object_mut()
                    .unwrap()
                    .insert("accountId".into(), json!(a));
            }
            let result = client.call_tool("listFolders", args)?;
            check_error(&result)?;
            format::print_folders(&result);
        }

        Command::Update {
            message_id,
            folder_path,
            read,
            unread,
            flag,
            unflag,
            move_to,
            trash,
        } => {
            let mut args = json!({
                "messageId": message_id,
                "folderPath": folder_path,
            });
            let obj = args.as_object_mut().unwrap();
            if read {
                obj.insert("read".into(), json!(true));
            }
            if unread {
                obj.insert("read".into(), json!(false));
            }
            if flag {
                obj.insert("flagged".into(), json!(true));
            }
            if unflag {
                obj.insert("flagged".into(), json!(false));
            }
            if let Some(m) = move_to {
                obj.insert("moveTo".into(), json!(m));
            }
            if trash {
                obj.insert("trash".into(), json!(true));
            }
            let result = client.call_tool("updateMessage", args)?;
            check_error(&result)?;
            if let Some(actions) = result.get("actions").and_then(|v| v.as_array()) {
                let action_strs: Vec<&str> = actions
                    .iter()
                    .filter_map(|a| a.as_str())
                    .collect();
                println!("Done: {}", action_strs.join(", "));
            }
        }

        Command::Send {
            to,
            subject,
            body,
            cc,
            bcc,
            from,
            html,
            attachments,
        } => {
            let mut args = json!({
                "to": to,
                "subject": subject.unwrap_or_default(),
                "body": body.unwrap_or_default(),
                "isHtml": html,
            });
            let obj = args.as_object_mut().unwrap();
            if let Some(cc_val) = cc {
                obj.insert("cc".into(), json!(cc_val));
            }
            if let Some(bcc_val) = bcc {
                obj.insert("bcc".into(), json!(bcc_val));
            }
            if let Some(from_val) = from {
                obj.insert("from".into(), json!(from_val));
            }
            if !attachments.is_empty() {
                obj.insert("attachments".into(), json!(attachments));
            }
            let result = client.call_tool("sendMail", args)?;
            check_error(&result)?;
            let msg = result
                .get("message")
                .and_then(|v| v.as_str())
                .unwrap_or("Compose window opened.");
            println!("{}", msg);
        }

        Command::Reply {
            message_id,
            folder_path,
            body,
            reply_all,
            html,
            to,
            cc,
            from,
            attachments,
        } => {
            let mut args = json!({
                "messageId": message_id,
                "folderPath": folder_path,
                "body": body,
                "replyAll": reply_all,
                "isHtml": html,
            });
            let obj = args.as_object_mut().unwrap();
            if let Some(to_val) = to {
                obj.insert("to".into(), json!(to_val));
            }
            if let Some(cc_val) = cc {
                obj.insert("cc".into(), json!(cc_val));
            }
            if let Some(from_val) = from {
                obj.insert("from".into(), json!(from_val));
            }
            if !attachments.is_empty() {
                obj.insert("attachments".into(), json!(attachments));
            }
            let result = client.call_tool("replyToMessage", args)?;
            check_error(&result)?;
            let msg = result
                .get("message")
                .and_then(|v| v.as_str())
                .unwrap_or("Reply compose window opened.");
            println!("{}", msg);
        }

        Command::Forward {
            message_id,
            folder_path,
            to,
            body,
            html,
            cc,
            from,
            attachments,
        } => {
            let mut args = json!({
                "messageId": message_id,
                "folderPath": folder_path,
                "to": to,
                "isHtml": html,
            });
            let obj = args.as_object_mut().unwrap();
            if let Some(body_val) = body {
                obj.insert("body".into(), json!(body_val));
            }
            if let Some(cc_val) = cc {
                obj.insert("cc".into(), json!(cc_val));
            }
            if let Some(from_val) = from {
                obj.insert("from".into(), json!(from_val));
            }
            if !attachments.is_empty() {
                obj.insert("attachments".into(), json!(attachments));
            }
            let result = client.call_tool("forwardMessage", args)?;
            check_error(&result)?;
            let msg = result
                .get("message")
                .and_then(|v| v.as_str())
                .unwrap_or("Forward compose window opened.");
            println!("{}", msg);
        }

        Command::Contacts { query } => {
            let result = client.call_tool("searchContacts", json!({ "query": query }))?;
            check_error(&result)?;
            format::print_contacts(&result);
        }

        Command::Calendars => {
            let result = client.call_tool("listCalendars", json!({}))?;
            check_error(&result)?;
            format::print_calendars(&result);
        }

        Command::Sync { folder, timeout } => {
            // Use a longer HTTP timeout to accommodate the extension-side sync timeout
            // plus overhead for request/response transit
            let http_timeout = Duration::from_millis(timeout + 10_000);
            let sync_client = ThunderbirdClient::with_timeout(http_timeout);
            let result = sync_client.call_tool(
                "syncFolder",
                json!({
                    "folderPath": folder,
                    "timeoutMs": timeout,
                }),
            )?;
            check_error(&result)?;
            format::print_sync_result(&result);
        }
    }

    Ok(())
}

fn check_error(result: &Value) -> Result<()> {
    if let Some(err) = result.get("error").and_then(|v| v.as_str()) {
        anyhow::bail!("{}", err);
    }
    Ok(())
}
