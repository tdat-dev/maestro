//! Names for the browser profiles the extension connects from. The extension
//! only knows the signed-in email; the profile's display name ("GravityCare",
//! "Work") lives in the browser's `Local State` file.

use std::path::PathBuf;

fn user_data_dir(browser: &str) -> Option<PathBuf> {
    let local = PathBuf::from(std::env::var("LOCALAPPDATA").ok()?);
    let b = browser.to_lowercase();
    let rel = if b.contains("edge") {
        "Microsoft/Edge/User Data"
    } else if b.contains("brave") {
        "BraveSoftware/Brave-Browser/User Data"
    } else if b.contains("vivaldi") {
        "Vivaldi/User Data"
    } else if b.contains("chromium") {
        "Chromium/User Data"
    } else {
        "Google/Chrome/User Data"
    };
    Some(local.join(rel))
}

/// The display name of the profile signed in as `email`, or "" when unknown.
pub fn profile_name(browser: &str, email: &str) -> String {
    if email.is_empty() {
        return String::new();
    }
    let Some(dir) = user_data_dir(browser) else { return String::new() };
    let Ok(raw) = std::fs::read_to_string(dir.join("Local State")) else { return String::new() };
    name_in_local_state(&raw, email)
}

pub fn name_in_local_state(raw: &str, email: &str) -> String {
    let Ok(v) = serde_json::from_str::<serde_json::Value>(raw) else { return String::new() };
    let Some(cache) = v["profile"]["info_cache"].as_object() else { return String::new() };
    cache
        .values()
        .find(|p| p["user_name"].as_str().is_some_and(|u| u.eq_ignore_ascii_case(email)))
        .and_then(|p| p["name"].as_str())
        .unwrap_or("")
        .to_string()
}

#[cfg(test)]
mod tests {
    #[test]
    fn finds_the_profile_by_its_account() {
        let raw = r#"{"profile":{"info_cache":{"Default":{"name":"Your Chrome","user_name":"a@x.com"},"Profile 2":{"name":"GravityCare","user_name":"B@x.com"}}}}"#;
        assert_eq!(super::name_in_local_state(raw, "b@x.com"), "GravityCare");
        assert_eq!(super::name_in_local_state(raw, "c@x.com"), "");
    }
}
