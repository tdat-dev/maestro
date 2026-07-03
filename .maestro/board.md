# Board

## Proposed (19)

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
- [ ] Harvest 343 missing strings
  Run scanAdminText.js --sync; needs backend up + ADMIN_TEXT_API_BASE_URL/SYNC_TOKEN (local PG off now)
- [ ] Decide if feature is actually used
  0/3679 strings ever customized — confirm someone will adopt before investing more coverage
- [ ] Migrate to key-based engine
  Phase 4 (deferred): retire DOM-bridge, adopt keyed component across pages — premature for an unused feature
- [ ] Review & chuẩn hoá tài liệu chức năng WF2
  Tự review với Claude để rút gọn + chuẩn format tài liệu chức năng cơ bản WF2 khách hàng (docs/wf2-tai-lieu-chuc-nang-co-ban.md)
- [ ] Vẽ flow WF2 bằng draw.io
  Hoàn thiện flow nghiệp vụ/thanh toán WF2 trên draw.io (docs/wf2-customer-service-flows.drawio): đặt+thanh toán, nhận+dùng PIN, đủ nhánh worst-case
- [ ] Audit kiến trúc hệ thống hiện tại
  Map 5 sub-project + backend; xác định bottleneck, nợ kỹ thuật, điểm khó scale trước khi redesign
- [ ] Quyết định stack & nền tảng
  Chọn ngôn ngữ/framework tối ưu; app native vs webapp vs PWA cho từng đối tượng (khách/station/admin)
- [ ] Thiết kế kiến trúc scale 5-10 năm
  Mô hình mở rộng: monolith→service, DB read-replica/shard, cache, queue, multi-region; chịu tải dài hạn
- [ ] Roadmap xây dựng hệ thống lớn
  Các bước build hệ thống lớn: discovery→PRD→RFC→data schema→API→build→test→release; mốc & thứ tự ưu tiên
- [ ] Deploy kanban mới
  YOUR gate: branch off develop, conventional commit, chạy migrate; workspace prod dính CF cache (nhớ purge zone)

## To do (0)

_(empty)_

## Doing (0)

_(empty)_

## Done (15)

- [x] Audit admin text-editing system
  Engine = global DOM string-replace; keyed component dead; 3679 strings harvested but 0 ever customized
- [x] Fix admin text engine
  Cover dialogs/menus (portals) + per-screen scoping (442 collisions) + bounded perf + cycle guard; local uncommitted, 0 TS errors, reviewed
- [x] Map coverage gap
  343 real strings still unharvested: audit-timeline 195, text-workspace 94, rest scattered
- [x] Commit + deploy engine fix
  YOUR gate: branch off develop, conventional commit; touches SSR admin entry (high-blast) — watch cold-boot health flake
- [x] Browser-QA engine fix
  Needs admin running + login: edit a string, confirm duplicated word changes only on its screen, confirm a dialog updates, no scroll jank
- [x] Mockup UI kanban mới (duyệt trước khi code)
  Board sạch, cột To Do/In Progress/Blocked/Done, card gọn, subtask/checklist tách rõ để todo list không rối; đưa vài format design duyệt trước
- [x] Code giao diện kanban mới (whalelo-workspace)
  React19/Vite: kéo-thả cột, card gọn, lọc theo người, checklist/subtask hiển thị rõ ràng chống rối todo list
- [x] MCP server cho workspace kanban
  MCP tools: list/create/update/move task + decompose task→subtasks; nối AI đọc/ghi board qua API whalelo-backend (token + scope)
- [x] Audit kanban công việc workspace hiện tại
  Map TasksTrelloBoard.jsx (26.7K) + saveTask/reorderTasks + model task (status/checklist/labels/assignee/projectId/boardPosition); xác định chỗ UI bị rối và thiếu tính năng team
- [x] Chốt scope: UI mới + team + MCP
  Quyết định nâng cấp hay thay board cũ; định nghĩa 'giống hệt Trello': cột tuỳ biến, card, nhiều assignee, team IT 2 người cùng làm 1 board
- [x] Model & API board + team
  Thêm khái niệm board/team + membership nhiều người, nhiều assignee/card; migration + RBAC keys tasks.*; chạy sequelize db:migrate ngay
- [x] AI phân tách task chuẩn (không rối)
  YOUR quyết định rule tách: 1 task lớn → checklist/subtask có cấu trúc + nhãn + độ ưu tiên, để nhìn todo list gọn gàng
- [x] RBAC + audit cho tính năng mới
  Mỗi action board/team/MCP kèm permission key + log sự kiện; kiểm tra scope own/any trước khi ship
- [x] Test kanban + MCP
  Jest: saveTask/reorder/team + MCP tools; UI QA browser kéo-thả với 2 user; pass trước khi deploy
- [x] Cộng tác team kiểu Trello
  Mời/gán 2 thành viên IT vào board, phân công card theo người, avatar/assignee, cập nhật realtime qua socket
