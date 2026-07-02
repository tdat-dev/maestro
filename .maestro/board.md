# Board

## Proposed (9)

- [ ] Lập danh mục chức năng
  Liệt kê toàn bộ feature từ README + src/ modules (wizard, terminal, broadcast, diff, kanban, pomodoro, dock, mascot)
- [ ] Phân tích Workspace & Wizard
  Đọc wizard.ts + workspaces.ts: luồng chọn folder, preset, grid 1-12, multi-select model
- [ ] Phân tích Terminal/ConPTY
  Đọc terminal.ts + ipc.ts + src-tauri: spawn agent, tree-kill, xterm.js, vòng đời pane
- [ ] Phân tích Tiling & Detach/Merge
  Trong main.ts: tiling frameless, control pill, drag reorder, detach ra cửa sổ riêng rồi merge
- [ ] Phân tích Diff review
  Đọc diff.ts + diffview.ts: cách review thay đổi từng agent, hiển thị diff
- [ ] Phân tích Tool dock (Kanban/Pomodoro)
  Đọc dock.ts, dockstore.ts, kanban.ts, pomodoro.ts: tính năng v0.2.0 mới thêm
- [ ] Phân tích Broadcast & Crew
  Đọc crew.ts: broadcast 1 lệnh tới nhiều agent, chọn nhóm agent nhận
- [ ] Đánh giá chất lượng & độ phủ test
  Soát các *.test.ts hiện có, chỉ ra module thiếu test và rủi ro
- [ ] Tổng hợp báo cáo phân tích
  Viết docs/feature-analysis.md: bảng feature, điểm mạnh/yếu, đề xuất cải thiện

## To do (0)

_(empty)_

## Doing (0)

_(empty)_

## Done (0)

_(empty)_
