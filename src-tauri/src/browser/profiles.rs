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

/// One profile of an installed Chromium browser, for Settings → Browser.
#[derive(serde::Serialize, Clone, Debug)]
pub struct ProfileRow {
    pub browser: String,
    pub dir: String,
    pub name: String,
    pub email: String,
}

const BROWSERS: [(&str, &str); 3] = [
    ("Google Chrome", "Google/Chrome"),
    ("Microsoft Edge", "Microsoft/Edge"),
    ("Brave", "BraveSoftware/Brave-Browser"),
];

/// Every profile of every installed Chrome, Edge and Brave, in the browser's
/// own order.
pub fn all_profiles() -> Vec<ProfileRow> {
    let Ok(local) = std::env::var("LOCALAPPDATA") else { return vec![] };
    let mut rows = vec![];
    for (browser, rel) in BROWSERS {
        let path = PathBuf::from(&local).join(rel).join("User Data").join("Local State");
        let Ok(raw) = std::fs::read_to_string(path) else { continue };
        rows.extend(rows_in_local_state(browser, &raw));
    }
    rows
}

pub fn rows_in_local_state(browser: &str, raw: &str) -> Vec<ProfileRow> {
    let Ok(v) = serde_json::from_str::<serde_json::Value>(raw) else { return vec![] };
    let Some(cache) = v["profile"]["info_cache"].as_object() else { return vec![] };
    let order: Vec<String> = v["profile"]["profiles_order"]
        .as_array()
        .map(|a| a.iter().filter_map(|s| s.as_str().map(String::from)).collect())
        .unwrap_or_default();
    let mut rows: Vec<ProfileRow> = cache
        .iter()
        .map(|(dir, p)| ProfileRow {
            browser: browser.to_string(),
            dir: dir.clone(),
            name: p["name"].as_str().unwrap_or(dir).to_string(),
            email: p["user_name"].as_str().unwrap_or("").to_string(),
        })
        .collect();
    rows.sort_by_key(|r| order.iter().position(|d| *d == r.dir).unwrap_or(usize::MAX));
    rows
}

/// The browser's executable, from the usual install places.
pub fn browser_exe(browser: &str) -> Option<PathBuf> {
    let rel = match browser {
        "Microsoft Edge" => r"Microsoft\Edge\Application\msedge.exe",
        "Brave" => r"BraveSoftware\Brave-Browser\Application\brave.exe",
        _ => r"Google\Chrome\Application\chrome.exe",
    };
    ["ProgramFiles", "ProgramFiles(x86)", "LOCALAPPDATA"]
        .iter()
        .filter_map(|v| std::env::var(v).ok())
        .map(|base| PathBuf::from(base).join(rel))
        .find(|p| p.exists())
}

#[cfg(test)]
mod rows_tests {
    #[test]
    fn lists_profiles_in_the_browser_order() {
        let raw = r#"{"profile":{"profiles_order":["Profile 2","Default"],"info_cache":{"Default":{"name":"Your Chrome","user_name":"a@x.com"},"Profile 2":{"name":"GravityCare","user_name":"b@x.com"}}}}"#;
        let rows = super::rows_in_local_state("Google Chrome", raw);
        assert_eq!(rows.iter().map(|r| r.name.as_str()).collect::<Vec<_>>(), ["GravityCare", "Your Chrome"]);
        assert_eq!(rows[0].dir, "Profile 2");
    }
}
