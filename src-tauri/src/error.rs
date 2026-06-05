use serde::Serialize;

#[derive(Debug, thiserror::Error, Serialize)]
pub enum CommandError {
    #[error("{0}")]
    Failed(String),
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
