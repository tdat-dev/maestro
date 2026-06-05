#[derive(Debug, Clone)]
pub struct CommandSpec {
    pub program: String,
    pub args: Vec<String>,
    pub cwd: Option<String>,
    pub env: Vec<(String, String)>,
}

impl CommandSpec {
    pub fn new(program: impl Into<String>) -> Self {
        CommandSpec {
            program: program.into(),
            args: Vec::new(),
            cwd: None,
            env: Vec::new(),
        }
    }

    pub fn arg(mut self, a: impl Into<String>) -> Self {
        self.args.push(a.into());
        self
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builds_program_and_args() {
        let spec = CommandSpec::new("cmd.exe").arg("/C").arg("echo hi");
        assert_eq!(spec.program, "cmd.exe");
        assert_eq!(spec.args, vec!["/C".to_string(), "echo hi".to_string()]);
        assert!(spec.cwd.is_none());
        assert!(spec.env.is_empty());
    }
}
