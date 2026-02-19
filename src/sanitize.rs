/// Sanitize JSON that may contain invalid control characters.
/// Email bodies often contain raw control chars that break JSON parsing.
///
/// Pass 1: Remove control chars except \n, \r, \t.
/// Pass 2: Escape raw (unescaped) \r, \n, \t with proper backslash parity tracking.
pub fn sanitize_json(data: &str) -> String {
    // Pass 1: remove control chars except \n (0x0A), \r (0x0D), \t (0x09)
    let pass1: String = data
        .chars()
        .filter(|&ch| {
            if ch.is_control() {
                matches!(ch, '\n' | '\r' | '\t')
            } else {
                true
            }
        })
        .collect();

    // Pass 2: escape raw newlines/carriage returns/tabs that aren't already escaped.
    // Track backslash parity via toggle (not assign) to handle \\<LF> correctly.
    let mut result = String::with_capacity(pass1.len());
    let mut prev_backslash = false;

    for ch in pass1.chars() {
        if ch == '\\' {
            prev_backslash = !prev_backslash; // TOGGLE, not assign
            result.push(ch);
        } else if !prev_backslash {
            match ch {
                '\n' => result.push_str("\\n"),
                '\r' => result.push_str("\\r"),
                '\t' => result.push_str("\\t"),
                _ => result.push(ch),
            }
            // prev_backslash is already false
        } else {
            // preceded by odd number of backslashes - already escaped
            result.push(ch);
            prev_backslash = false;
        }
    }

    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normal_json_unchanged() {
        let input = r#"{"key": "value", "num": 42}"#;
        assert_eq!(sanitize_json(input), input);
    }

    #[test]
    fn removes_control_chars() {
        let input = "hello\x00\x01\x02world";
        assert_eq!(sanitize_json(input), "helloworld");
    }

    #[test]
    fn escapes_raw_newline() {
        let input = "line1\nline2";
        assert_eq!(sanitize_json(input), "line1\\nline2");
    }

    #[test]
    fn escapes_raw_tab() {
        let input = "col1\tcol2";
        assert_eq!(sanitize_json(input), "col1\\tcol2");
    }

    #[test]
    fn escapes_raw_carriage_return() {
        let input = "line1\rline2";
        assert_eq!(sanitize_json(input), "line1\\rline2");
    }

    #[test]
    fn preserves_already_escaped() {
        // \\n in source = literal backslash + n in string
        let input = r#"already \\n escaped"#;
        // The \\ toggles prev_backslash true then false, so n is not preceded by odd backslash
        // Wait - let's think: input has chars: 'a','l',...,' ','\\','\\','n',' ',...
        // At first \\: toggle to true. At second \\: toggle to false. At n: not preceded, just push n.
        assert_eq!(sanitize_json(input), input);
    }

    #[test]
    fn already_escaped_newline_preserved() {
        // Input: backslash followed by literal n - this is an escaped \n in JSON
        let input = "test\\nvalue";
        // At \\: toggle to true. At n: preceded by backslash, push n, reset to false.
        assert_eq!(sanitize_json(input), "test\\nvalue");
    }

    #[test]
    fn double_backslash_then_raw_newline() {
        // Input: two backslashes then a raw newline. The double backslash is a literal \\,
        // and the newline is unescaped. Should escape the newline.
        let input = "test\\\\\nvalue";
        // At first \\: toggle to true. At second \\: toggle to false.
        // At \n: !prev_backslash, so escape it.
        assert_eq!(sanitize_json(input), "test\\\\\\nvalue");
    }

    #[test]
    fn empty_input() {
        assert_eq!(sanitize_json(""), "");
    }

    #[test]
    fn only_control_chars() {
        let input = "\x00\x01\x02\x03";
        assert_eq!(sanitize_json(input), "");
    }
}
