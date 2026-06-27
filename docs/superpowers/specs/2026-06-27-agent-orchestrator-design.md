# Agent Orchestrator — Scout / Builder / Reviewer loop

**Date:** 2026-06-27
**Status:** Approved design, ready for implementation planning.

## Mục tiêu

Một project Python độc lập điều phối ba tác nhân — **Scout**, **Builder**,
**Reviewer** — mỗi tác nhân gắn với một AI CLI/model khác nhau. Hệ thống tự
chạy code AI vừa viết, bắt lỗi từ terminal (stderr/exit-code) và (tùy chọn)
Sentry, feed lỗi lại cho Builder, và **lặp cho tới khi test pass + Reviewer
duyệt** (có trần `max_iterations`).

Trái tim điều khiển trạng thái và vòng lặp là **LangGraph**.

## Quyết định đã chốt

| Khía cạnh | Quyết định |
|-----------|-----------|
| Phạm vi | Project Python độc lập, chạy bằng CLI (`python -m orchestrator ...`). Không đụng codebase Tauri/TS của Maestro. |
| Gọi AI | Qua **CLI headless có sẵn** (`claude -p`, `codex exec`, `gemini -p`...). Mỗi vai gán một CLI/model. Tận dụng login sẵn, không cần API key riêng. |
| Cách ly | **Git worktree + branch** off HEAD; chạy test local. |
| Input | **Auto-detect**: thư mục trống → scaffold project mới; có code → sửa repo sẵn. |
| Điều kiện dừng | **Test pass (exit 0) AND Reviewer duyệt**, với trần `max_iterations` (mặc định 6). |
| Nguồn lỗi | **stderr/exit-code** (chính) **+ Sentry API** (phụ trợ, optional — chỉ bật khi có DSN/token). |
| Hướng kiến trúc | **A** — LangGraph điều phối, CLI tự sửa file (không patch-based). |

## Kiến trúc

### Hướng A — LangGraph điều phối, CLI tự sửa file

LangGraph giữ state và vòng lặp. Mỗi node shell ra CLI headless với
`cwd=worktree`; bản thân `claude`/`codex` là coding agent, tự đọc & sửa file.
Orchestrator chỉ chịu trách nhiệm: định tuyến, chạy test, gom lỗi, và quyết
định dừng. Lựa chọn này tận dụng tối đa năng lực coding của CLI và tránh phải
parse/apply patch mong manh.

(Đã cân nhắc và loại: **B** patch-based — dễ vỡ vì CLI không xuất patch sạch;
**C** while-loop thuần — mất checkpoint/streaming/visualize của LangGraph.)

### Cấu trúc package `orchestrator/`

| File | Trách nhiệm | Phụ thuộc |
|------|-------------|-----------|
| `__main__.py` | CLI entry: `run --repo PATH --goal "..."` | `config`, `graph` |
| `config.py` | Load config (yaml/env): map vai→CLI/model, `max_iterations`, test/build cmd (hoặc auto), cấu hình Sentry | — |
| `state.py` | `TypedDict` định nghĩa state của LangGraph | — |
| `graph.py` | Wiring `StateGraph` + conditional edges; hàm `route(state)` thuần | tất cả module dưới |
| `cli_agents.py` | `run_agent(role, prompt, cwd) -> AgentResult`: gọi CLI headless, timeout, retry 1 lần, capture stdout | `config` |
| `worktree.py` | Tạo/dọn git worktree + branch off HEAD; scaffold nếu thư mục trống | — |
| `executor.py` | Auto-detect project type → chạy test/build, capture stdout/stderr/exit-code | — |
| `errors.py` | `ErrorSource` interface + adapter `TerminalErrorSource`, `SentryErrorSource`; gom & format cho Builder | `config` |
| `prompts.py` | Template prompt cho từng vai | — |

Mỗi module có **một nhiệm vụ rõ ràng**, giao tiếp qua interface hẹp, test độc
lập được. Các hàm quyết định (`route`, parse, auto-detect, format lỗi) là hàm
**thuần** để dễ unit-test mà không cần subprocess thật.

### State (`state.py`)

`TypedDict` gồm:

- `goal: str` — mục tiêu ngôn ngữ tự nhiên
- `repo_path: str` — thư mục gốc người dùng trỏ vào
- `worktree_path: str` — worktree cách ly đang làm việc
- `branch: str`
- `mode: Literal["create", "edit"]` — auto-detect
- `plan: str` — kế hoạch Scout sinh ra
- `iteration: int`
- `max_iterations: int`
- `last_exec: ExecResult | None` — stdout/stderr/exit gần nhất
- `errors: list[ErrorEvent]` — đã gom & format
- `review: ReviewVerdict | None` — `{approved: bool, blocking: [...], notes}`
- `needs_rescout: bool` — Reviewer có thể yêu cầu lập lại kế hoạch
- `history: list[...]` — log các bước (cho debug/visualize)
- `outcome: Literal["success", "maxed", "failed"] | None`

### Luồng graph (`graph.py`)

```
START → setup_worktree → scout → builder → execute → collect_errors → reviewer → route
route:
  • no_errors AND review.approved        → finalize(success) → END
  • iteration >= max_iterations          → finalize(maxed)   → END
  • needs_rescout                        → scout
  • else: iteration++, feed(errors + review notes) → builder
```

- **Scout** chạy một lần ở đầu (khảo sát repo, lập kế hoạch + chia task). Có
  thể được gọi lại nếu Reviewer set `needs_rescout`.
- **Builder** viết/sửa code theo task; ở các vòng sau nhận thêm `errors` +
  `review.notes` làm feedback.
- **execute** chạy test/build, đổ kết quả vào `last_exec`.
- **collect_errors** gom từ Terminal source (+ Sentry nếu bật), format gọn.
- **Reviewer** đọc lỗi + diff, ra verdict `{approved, blocking, notes}`.

### Điều kiện dừng

`exit_code == 0` (Terminal source sạch) **AND** Reviewer verdict `approved`.
Trần `max_iterations` (mặc định **6**) để tránh lặp vô tận → outcome `maxed`.
Sentry là input **phụ trợ** cho Builder (nếu cấu hình); không tự chặn dừng trừ
khi bật chế độ strict.

### Bắt lỗi (`errors.py`)

`ErrorSource` interface: `collect() -> list[ErrorEvent]`.

- `TerminalErrorSource` — dựng từ `ExecResult` (stderr + exit-code).
- `SentryErrorSource` — kéo recent issues qua Sentry API (cần DSN/token trong
  config). **Optional**: không cấu hình thì bỏ qua.

Aggregator gộp các source, format thành đoạn text gọn cho Builder.

### Parse output CLI (khoan dung)

- **Scout** xuất plan trong fenced ```json block.
- **Reviewer** xuất `{approved: bool, blocking: [...], notes: str}`.
- **Builder** free-form (tự sửa file trong worktree).

Parser khoan dung: trích block JSON cuối cùng, fallback về raw text. Parse fail
→ coi như "chưa duyệt", log lại, lặp tiếp (không crash).

### Error handling vận hành

- CLI timeout / exit nonzero → retry **1 lần** → đánh dấu agent failure &
  surface ra outcome `failed`.
- Worktree luôn dọn trong `finally`.
- Mỗi lần gọi CLI ghi log vào `logs/run-<id>/` để debug.

## Chiến lược test

Dùng **pytest**.

- **Unit** cho các hàm thuần, mock subprocess:
  - auto-detect project type (`package.json`→npm, `pyproject.toml`/`requirements.txt`→pytest, `Cargo.toml`→cargo...)
  - parse/format `ErrorEvent`
  - `route(state) -> next_node` (bảng case: success / maxed / rescout / loop)
  - load config
- **Integration** với **fake CLI script** (echo output canned) để chạy cả
  graph mà không tốn model thật:
  - thư mục trống → scaffold
  - repo có lỗi → loop sửa cho tới khi "pass"

## Phạm vi loại trừ (YAGNI)

- Không tích hợp UI Maestro ở giai đoạn này (project độc lập).
- Không patch-based editing.
- Không multi-repo / song song nhiều goal cùng lúc (một goal mỗi lần chạy).
- Sentry strict-mode để sau; mặc định advisory.
