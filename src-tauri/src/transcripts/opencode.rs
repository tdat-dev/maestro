//! opencode keeps its sessions in a SQLite database
//! (`~/.local/share/opencode/opencode.db`): a `session` row per conversation
//! (with the folder it ran in), `message` rows (who spoke, model, agent,
//! tokens) and `part` rows (text, reasoning, tool calls with their state). A
//! part is rewritten in place while its tool runs, so the chat reads rows by
//! when they last changed, not by position, and the cursor is that time.

use std::path::{Path, PathBuf};
use std::time::Duration;

use rusqlite::{params, Connection, OpenFlags};

use crate::commands::TranscriptChunk;
use crate::error::{run_blocking, CommandError};

/// Most rows one read hands back, so a long session loads in slices.
const MAX_ROWS: usize = 2000;
/// Most bytes one read hands back (pasted pictures are kept inline as data URLs).
const MAX_BYTES: usize = 3 * 1024 * 1024;

/// Rows of an opencode agent's session that changed after `cursor` (a time in
/// ms), as JSONL: `session` when the chat already knows it, else the newest
/// top-level session in `dir` (touched since `since_ms`, when given). `path`
/// is the session id, "" until one exists.
#[tauri::command]
pub async fn opencode_transcript(
    dir: String,
    since_ms: Option<u64>,
    session: Option<String>,
    cursor: u64,
) -> Result<TranscriptChunk, CommandError> {
    run_blocking(move || {
        let Some(db) = db_path() else { return Ok(TranscriptChunk::default()) };
        Ok(opencode_transcript_in(&db, &dir, since_ms, session.as_deref(), cursor))
    })
    .await
}

fn db_path() -> Option<PathBuf> {
    let home = std::env::var("USERPROFILE").or_else(|_| std::env::var("HOME")).ok()?;
    let db = Path::new(&home).join(".local").join("share").join("opencode").join("opencode.db");
    db.exists().then_some(db)
}

/// "D:\\Zoldify\\" and "d:/zoldify" are the same folder.
fn same_dir(a: &str, b: &str) -> bool {
    let norm = |p: &str| p.replace('\\', "/").trim_end_matches('/').to_lowercase();
    norm(a) == norm(b)
}

fn opencode_transcript_in(db: &Path, dir: &str, since_ms: Option<u64>, session: Option<&str>, cursor: u64) -> TranscriptChunk {
    // opencode writes the database while it runs: read only, and wait out its locks.
    let Ok(conn) = Connection::open_with_flags(db, OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX) else {
        return TranscriptChunk::default();
    };
    let _ = conn.busy_timeout(Duration::from_millis(1500));
    let id = match session {
        Some(s) if !s.is_empty() => s.to_string(),
        _ => match newest_session(&conn, dir, since_ms) {
            Some(s) => s,
            None => return TranscriptChunk::default(),
        },
    };
    let (text, next) = rows_after(&conn, &id, cursor).unwrap_or_else(|_| (String::new(), cursor));
    TranscriptChunk { path: id, text, next }
}

/// The newest conversation begun in `dir` (a helper agent's session has a parent: not those).
fn newest_session(conn: &Connection, dir: &str, since_ms: Option<u64>) -> Option<String> {
    let since = since_ms.unwrap_or(0) as i64;
    let mut stmt = conn
        .prepare("SELECT id, directory FROM session WHERE parent_id IS NULL AND time_updated >= ?1 ORDER BY time_updated DESC LIMIT 500")
        .ok()?;
    let rows = stmt.query_map(params![since], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))).ok()?;
    let found = rows.flatten().find(|(_, d)| same_dir(d, dir)).map(|(id, _)| id);
    found
}

/// Message and part rows changed after `cursor`, oldest change first, one JSON
/// object per line: `{"kind":"message"|"part","id","messageId","created","updated","data":{…}}`.
fn rows_after(conn: &Connection, session: &str, cursor: u64) -> rusqlite::Result<(String, u64)> {
    let mut stmt = conn.prepare(
        "SELECT kind, id, message_id, time_created, time_updated, data FROM (
           SELECT 'message' AS kind, id, id AS message_id, time_created, time_updated, data FROM message WHERE session_id = ?1 AND time_updated > ?2
           UNION ALL
           SELECT 'part' AS kind, id, message_id, time_created, time_updated, data FROM part WHERE session_id = ?1 AND time_updated > ?2
         ) ORDER BY time_updated, kind, id LIMIT ?3",
    )?;
    let mut rows = stmt.query(params![session, cursor as i64, (MAX_ROWS + 1) as i64])?;
    let mut text = String::new();
    let mut next = cursor;
    let mut count = 0;
    let mut cut = false;
    while let Some(r) = rows.next()? {
        if count == MAX_ROWS || text.len() > MAX_BYTES {
            cut = true;
            break;
        }
        let data: String = r.get(5)?;
        let data: serde_json::Value = serde_json::from_str(&data).unwrap_or(serde_json::Value::String(data));
        let updated: i64 = r.get(4)?;
        let line = serde_json::json!({
            "kind": r.get::<_, String>(0)?,
            "id": r.get::<_, String>(1)?,
            "messageId": r.get::<_, String>(2)?,
            "created": r.get::<_, i64>(3)?,
            "updated": updated,
            "data": data,
        });
        text.push_str(&line.to_string());
        text.push('\n');
        next = next.max(updated.max(0) as u64);
        count += 1;
    }
    // A slice cut short ends one ms early, so rows sharing its last time are read again (the chat upserts them).
    if cut && next > cursor + 1 {
        next -= 1;
    }
    Ok((text, next))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_db(name: &str) -> PathBuf {
        let path = std::env::temp_dir().join(format!("maestro-opencode-{name}-{}.db", std::process::id()));
        let _ = std::fs::remove_file(&path);
        let conn = Connection::open(&path).unwrap();
        conn.execute_batch(
            "CREATE TABLE session (id text PRIMARY KEY, project_id text NOT NULL, parent_id text, slug text NOT NULL, directory text NOT NULL, title text NOT NULL, version text NOT NULL, time_created integer NOT NULL, time_updated integer NOT NULL);
             CREATE TABLE message (id text PRIMARY KEY, session_id text NOT NULL, time_created integer NOT NULL, time_updated integer NOT NULL, data text NOT NULL);
             CREATE TABLE part (id text PRIMARY KEY, message_id text NOT NULL, session_id text NOT NULL, time_created integer NOT NULL, time_updated integer NOT NULL, data text NOT NULL);
             INSERT INTO session VALUES ('ses_old', 'p', NULL, 's', 'D:\\app', 'old', '1', 100, 200);
             INSERT INTO session VALUES ('ses_new', 'p', NULL, 's', 'D:/App/', 'new', '1', 1000, 1500);
             INSERT INTO session VALUES ('ses_kid', 'p', 'ses_new', 's', 'D:/app', 'helper', '1', 1100, 9000);
             INSERT INTO session VALUES ('ses_else', 'p', NULL, 's', 'E:/other', 'else', '1', 1000, 9500);
             INSERT INTO message VALUES ('msg_1', 'ses_new', 1000, 1001, '{\"role\":\"user\",\"agent\":\"build\"}');
             INSERT INTO part VALUES ('prt_1', 'msg_1', 'ses_new', 1000, 1002, '{\"type\":\"text\",\"text\":\"hi\"}');
             INSERT INTO message VALUES ('msg_2', 'ses_new', 1003, 1010, '{\"role\":\"assistant\"}');
             INSERT INTO part VALUES ('prt_2', 'msg_2', 'ses_new', 1004, 1009, '{\"type\":\"tool\",\"tool\":\"bash\",\"state\":{\"status\":\"completed\"}}');",
        )
        .unwrap();
        path
    }

    #[test]
    fn finds_the_newest_top_level_session_in_the_folder() {
        let db = temp_db("find");
        let c = opencode_transcript_in(&db, "d:\\app", None, None, 0);
        assert_eq!(c.path, "ses_new");
        assert_eq!(opencode_transcript_in(&db, "D:/app", Some(1600), None, 0).path, "");
        assert_eq!(opencode_transcript_in(&db, "D:/nowhere", None, None, 0).path, "");
        let _ = std::fs::remove_file(&db);
    }

    #[test]
    fn hands_back_rows_changed_after_the_cursor_in_order() {
        let db = temp_db("rows");
        let c = opencode_transcript_in(&db, "D:/app", None, None, 0);
        let lines: Vec<serde_json::Value> = c.text.lines().map(|l| serde_json::from_str(l).unwrap()).collect();
        let ids: Vec<&str> = lines.iter().map(|l| l["id"].as_str().unwrap()).collect();
        assert_eq!(ids, ["msg_1", "prt_1", "prt_2", "msg_2"]);
        assert_eq!(lines[1]["messageId"], "msg_1");
        assert_eq!(lines[1]["data"]["text"], "hi");
        assert_eq!(c.next, 1010);
        // nothing new: nothing handed back, the cursor stays
        let again = opencode_transcript_in(&db, "D:/app", None, Some("ses_new"), c.next);
        assert_eq!((again.text.as_str(), again.next), ("", 1010));
        // a part rewritten later comes back
        let conn = Connection::open(&db).unwrap();
        conn.execute("UPDATE part SET time_updated = 1020, data = '{\"type\":\"text\",\"text\":\"hi!\"}' WHERE id = 'prt_1'", []).unwrap();
        let later = opencode_transcript_in(&db, "D:/app", None, Some("ses_new"), c.next);
        assert!(later.text.contains("hi!"));
        assert_eq!(later.next, 1020);
        drop(conn);
        let _ = std::fs::remove_file(&db);
    }

    #[test]
    fn a_missing_database_is_nothing_yet() {
        let c = opencode_transcript_in(Path::new("Z:/no/such/opencode.db"), "D:/app", None, None, 0);
        assert_eq!(c.path, "");
    }
}
