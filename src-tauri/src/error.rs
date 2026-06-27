use serde::Serialize;

#[derive(Debug, thiserror::Error, Serialize)]
pub enum CommandError {
    #[error("{0}")]
    Failed(String),
    /// A write was rejected because the file changed on disk since it was read.
    /// Carries the current on-disk mtime (ms) so the UI can offer reload/overwrite.
    #[error("file changed on disk")]
    Conflict(i64),
}

impl From<anyhow::Error> for CommandError {
    fn from(e: anyhow::Error) -> Self {
        CommandError::Failed(e.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn serializes_to_stable_shape() {
        let e = CommandError::Failed("boom".into());
        let json = serde_json::to_string(&e).unwrap();
        assert_eq!(json, r#"{"Failed":"boom"}"#);
    }
}
