use serde_json::Value;

const MONTHS: [&str; 12] = [
    "Jan", "Feb", "Mar", "Apr", "May", "Jun",
    "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

/// Format an ISO 8601 date string as "19 Feb 2026 14:30".
/// Falls back to the raw string if parsing fails.
pub fn format_date(iso: &str) -> String {
    if iso.is_empty() {
        return String::new();
    }

    // Expect: 2026-02-19T14:30:00... (at minimum YYYY-MM-DDThh:mm)
    // We only need date and time parts, no external crate needed.
    let bytes = iso.as_bytes();
    if bytes.len() < 16 {
        return iso.to_string();
    }

    let year = &iso[0..4];
    let month: usize = match iso[5..7].parse() {
        Ok(m) if (1..=12).contains(&m) => m,
        _ => return iso.to_string(),
    };
    let day = &iso[8..10];
    let hour = &iso[11..13];
    let minute = &iso[14..16];

    format!("{} {} {} {}:{}", day, MONTHS[month - 1], year, hour, minute)
}

/// Truncate a string to max_len chars, appending "..." if truncated.
/// Replaces newlines with spaces first. Char-aware (safe for multi-byte).
pub fn truncate(s: &str, max_len: usize) -> String {
    if s.is_empty() {
        return String::new();
    }
    let cleaned: String = s.chars().map(|c| if c == '\n' { ' ' } else { c }).collect();
    let trimmed = cleaned.trim();
    if trimmed.chars().count() > max_len {
        let truncated: String = trimmed.chars().take(max_len.saturating_sub(3)).collect();
        format!("{}...", truncated)
    } else {
        trimmed.to_string()
    }
}

pub fn print_messages(messages: &Value) {
    let arr = match messages.as_array() {
        Some(a) if !a.is_empty() => a,
        _ => {
            println!("No messages found.");
            return;
        }
    };

    for msg in arr {
        let flags = build_flags(msg);
        let flag_str = if flags.is_empty() {
            String::new()
        } else {
            format!(" [{}]", flags)
        };

        let author = msg
            .get("author")
            .or_else(|| msg.get("from"))
            .and_then(|v| v.as_str())
            .unwrap_or("");

        let date = msg.get("date").and_then(|v| v.as_str()).unwrap_or("");
        let subject = msg
            .get("subject")
            .and_then(|v| v.as_str())
            .unwrap_or("(no subject)");
        let id = msg.get("id").and_then(|v| v.as_str()).unwrap_or("");
        let folder = msg
            .get("folderPath")
            .and_then(|v| v.as_str())
            .unwrap_or("");

        println!("{}  {}", format_date(date), truncate(author, 30));
        println!("  {}{}", subject, flag_str);
        println!("  id: {}  folder: {}", id, folder);
        println!();
    }

    println!("{} message(s)", arr.len());
}

pub fn print_message(msg: &Value) {
    if let Some(err) = msg.get("error").and_then(|v| v.as_str()) {
        eprintln!("Error: {}", err);
        std::process::exit(1);
    }

    let flags = build_flags(msg);
    let flag_str = if flags.is_empty() {
        String::new()
    } else {
        format!(" [{}]", flags)
    };

    let subject = msg
        .get("subject")
        .and_then(|v| v.as_str())
        .unwrap_or("(no subject)");
    let author = msg.get("author").and_then(|v| v.as_str()).unwrap_or("");
    let recipients = msg
        .get("recipients")
        .and_then(|v| v.as_str())
        .unwrap_or("");
    let cc = msg.get("ccList").and_then(|v| v.as_str());
    let date = msg.get("date").and_then(|v| v.as_str()).unwrap_or("");
    let id = msg.get("id").and_then(|v| v.as_str()).unwrap_or("");

    println!("Subject: {}{}", subject, flag_str);
    println!("From:    {}", author);
    println!("To:      {}", recipients);
    if let Some(cc_val) = cc {
        println!("CC:      {}", cc_val);
    }
    println!("Date:    {}", format_date(date));
    println!("ID:      {}", id);

    if let Some(attachments) = msg.get("attachments").and_then(|v| v.as_array()) {
        if !attachments.is_empty() {
            println!("\nAttachments ({}):", attachments.len());
            for att in attachments {
                let name = att.get("name").and_then(|v| v.as_str()).unwrap_or("unknown");
                let size_str = att
                    .get("size")
                    .and_then(|v| v.as_f64())
                    .map(|s| format!(" ({:.1}KB)", s / 1024.0))
                    .unwrap_or_default();
                let path_str = att
                    .get("filePath")
                    .and_then(|v| v.as_str())
                    .map(|p| format!(" -> {}", p))
                    .unwrap_or_default();
                let err_str = att
                    .get("error")
                    .and_then(|v| v.as_str())
                    .map(|e| format!(" [{}]", e))
                    .unwrap_or_default();
                println!("  {}{}{}{}", name, size_str, path_str, err_str);
            }
        }
    }

    let body = msg
        .get("body")
        .and_then(|v| v.as_str())
        .unwrap_or("(empty body)");
    println!("\n{}", body);
}

pub fn print_folders(folders: &Value) {
    let arr = match folders.as_array() {
        Some(a) if !a.is_empty() => a,
        _ => {
            println!("No folders found.");
            return;
        }
    };

    for f in arr {
        let depth = f.get("depth").and_then(|v| v.as_u64()).unwrap_or(0) as usize;
        let indent = "  ".repeat(depth);
        let name = f.get("name").and_then(|v| v.as_str()).unwrap_or("");
        let total = f
            .get("totalMessages")
            .and_then(|v| v.as_u64())
            .unwrap_or(0);
        let unread = f
            .get("unreadMessages")
            .and_then(|v| v.as_u64())
            .unwrap_or(0);
        let path = f.get("path").and_then(|v| v.as_str()).unwrap_or("");

        let unread_str = if unread > 0 {
            format!(" ({} unread)", unread)
        } else {
            String::new()
        };

        println!("{}{}  [{} msgs{}]", indent, name, total, unread_str);
        println!("{}  {}", indent, path);
    }
}

pub fn print_accounts(accounts: &Value) {
    let arr = match accounts.as_array() {
        Some(a) if !a.is_empty() => a,
        _ => {
            println!("No accounts found.");
            return;
        }
    };

    for acc in arr {
        let name = acc
            .get("name")
            .or_else(|| acc.get("key"))
            .and_then(|v| v.as_str())
            .unwrap_or("");
        let acc_type = acc.get("type").and_then(|v| v.as_str()).unwrap_or("");
        println!("{} ({})", name, acc_type);

        if let Some(identities) = acc.get("identities").and_then(|v| v.as_array()) {
            for id in identities {
                let id_name = id.get("name").and_then(|v| v.as_str()).unwrap_or("");
                let email = id.get("email").and_then(|v| v.as_str()).unwrap_or("");
                println!("  {} <{}>", id_name, email);
            }
        }
        println!();
    }
}

pub fn print_contacts(contacts: &Value) {
    let arr = match contacts.as_array() {
        Some(a) if !a.is_empty() => a,
        _ => {
            println!("No contacts found.");
            return;
        }
    };

    for c in arr {
        let first = c.get("firstName").and_then(|v| v.as_str()).unwrap_or("");
        let last = c.get("lastName").and_then(|v| v.as_str()).unwrap_or("");
        let display = c.get("displayName").and_then(|v| v.as_str()).unwrap_or("");

        let name = if !first.is_empty() || !last.is_empty() {
            [first, last]
                .iter()
                .filter(|s| !s.is_empty())
                .copied()
                .collect::<Vec<_>>()
                .join(" ")
        } else {
            display.to_string()
        };

        // Extension returns "email", not "primaryEmail"
        let email = c
            .get("email")
            .or_else(|| c.get("primaryEmail"))
            .and_then(|v| v.as_str())
            .unwrap_or("");

        println!("{}  <{}>", name, email);
    }

    println!("\n{} contact(s)", arr.len());
}

pub fn print_calendars(calendars: &Value) {
    let arr = match calendars.as_array() {
        Some(a) if !a.is_empty() => a,
        _ => {
            println!("No calendars found.");
            return;
        }
    };

    for cal in arr {
        let name = cal.get("name").and_then(|v| v.as_str()).unwrap_or("");
        let cal_type = cal
            .get("type")
            .and_then(|v| v.as_str())
            .unwrap_or("unknown");
        println!("{} ({})", name, cal_type);
        if let Some(color) = cal.get("color").and_then(|v| v.as_str()) {
            println!("  color: {}", color);
        }
    }
}

fn build_flags(msg: &Value) -> String {
    let mut parts = Vec::new();
    if msg.get("read") == Some(&Value::Bool(false)) {
        parts.push("UNREAD");
    }
    if msg.get("flagged") == Some(&Value::Bool(true)) {
        parts.push("FLAGGED");
    }
    parts.join(" ")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn format_date_valid() {
        assert_eq!(format_date("2026-02-19T14:30:00Z"), "19 Feb 2026 14:30");
    }

    #[test]
    fn format_date_empty() {
        assert_eq!(format_date(""), "");
    }

    #[test]
    fn format_date_short_fallback() {
        assert_eq!(format_date("2026"), "2026");
    }

    #[test]
    fn truncate_short() {
        assert_eq!(truncate("hello", 10), "hello");
    }

    #[test]
    fn truncate_long() {
        assert_eq!(truncate("hello world this is long", 10), "hello w...");
    }

    #[test]
    fn truncate_empty() {
        assert_eq!(truncate("", 10), "");
    }

    #[test]
    fn truncate_newlines() {
        assert_eq!(truncate("hello\nworld", 20), "hello world");
    }
}
