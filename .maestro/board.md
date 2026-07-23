# Board

## Proposed (4)

- [ ] Login: Gate dashboard web (Rust)
  Bắt session cookie cho dashboard server; đóng lỗ hổng /api/send gõ lệnh vào agent không cần auth.
  - [ ] Session store in-memory trong Dashboard state: token 32-byte CSPRNG + hạn 12h
  - [ ] POST /api/login: verify qua auth, set Set-Cookie maestro_sess HttpOnly SameSite=Strict
  - [ ] POST /api/logout: xóa session
  - [ ] Chặn /api/fleet & /api/send: thiếu cookie hợp lệ = 401
  - [ ] GET / chưa auth → phục vụ view login trong dashboard.html
  - [ ] Backend từ chối login khi chưa cấu hình credential
  - [ ] Test: 401 khi thiếu cookie, 200 khi có; login đúng/sai; session hết hạn
- [ ] Login: Khóa app desktop + boot gate (frontend)
  Overlay lock/setup theo phong cách app; nhớ máy này, có nút Khóa thủ công. Agent chạy nền phía dưới.
  - [ ] ipc.ts: wrapper cho auth_status/setup/verify/lock/change
  - [ ] src/auth.ts: quyết định boot (setup vs lock vs pass-through)
  - [ ] src/styles/auth.css: overlay tối, font Geist, accent #c6f135, dấu Maestro
  - [ ] Markup overlay trong index.html (setup + login panel)
  - [ ] main.ts: gọi auth_status lúc boot, chặn Home đến khi mở khóa
  - [ ] Nhớ máy: flag maestro.unlocked (localStorage); relaunch không hỏi lại
  - [ ] auth.ts test: 3 nhánh boot với ipc mock
- [ ] Login: Settings, first-run & spec/docs
  Nút Khóa + đổi đăng nhập trong Settings; disable toggle dashboard đến khi có credential; ghi spec + đường dẫn khôi phục.
  - [ ] Settings: nút 'Khóa ngay' → auth_lock + hiện màn đăng nhập
  - [ ] Settings: đổi username/password (auth_change)
  - [ ] Disable toggle 'Remote fleet dashboard' đến khi đã tạo login (tooltip nhắc)
  - [ ] Ghi spec docs/superpowers/specs/2026-07-11-login-design.md
  - [ ] Ghi chú khôi phục: xóa auth.json trong app-config dir → về first-run
  - [ ] Cập nhật cảnh báo LAN: đã có mật khẩu chắn
- [ ] Redesign P3: Full settings + backgrounds + English chrome
  Settings full màn 4 mục (Appearance/Fleet/Sessions/System) gộp toàn bộ setting hiện có; đổi nền canvas (preset+màu+ảnh); topbar gọn; toàn app English.
  - [ ] Settings full-screen: sidebar 4 mục, gom mọi setting Maestro hiện có + background picker
  - [ ] Background: preset/màu/ảnh (data-URI) áp vào canvas, lưu per-workspace
  - [ ] Topbar gọn (logo·tabs·live); command bar chrome; token/CSS dùng chung
  - [ ] i18n: chuyển toàn bộ UI sang tiếng Anh
  - [ ] Verify: mọi màn render đúng light? (dark-only) + screenshot review

## To do (0)

_(empty)_

## Doing (1)

- [ ] Login: Auth core (Rust)
  Kho credential nguồn-chân-lý trong Rust: 1 username + 1 password hash (argon2id), lưu auth.json trong app-config dir.
  - [ ] Thêm crate argon2 (+ rand) vào Cargo.toml
  - [ ] Module auth.rs: load/save auth.json, hash argon2id + salt, không lưu plaintext
  - [ ] Thêm Auth vào AppState (state.rs)
  - [ ] Commands: auth_status / auth_setup / auth_verify / auth_lock / auth_change
  - [ ] Delay cố định khi verify sai (chống brute-force)
  - [ ] Đăng ký commands trong lib.rs invoke_handler
  - [ ] Unit test: setup, verify đúng/sai, change, reject setup khi đã có

## Done (6)

- [x] Fix copy khi bôi đen trong pane Claude Code (OSC 52)
  Claude Code tự xử lý selection + copy qua escape OSC 52; xterm.js của Maestro không có handler nên clipboard không được ghi. Fix: đăng ký OSC 52 handler trong terminal.ts.
  - [ ] terminal.ts: registerOscHandler(52) — parse 'c;<base64>', decode UTF-8, navigator.clipboard.writeText
  - [ ] Bỏ qua query '?' (không trả lời — tránh app đọc trộm clipboard)
  - [ ] Unit test trong terminal.test.ts cho parse/decode OSC 52
  - [ ] Verify thật: chạy app, bôi đen text trong Claude Code, paste ra ngoài
- [x] Redesign P1: Canvas + focus + tidy + identity
  Đổi .grid tiling thành canvas pane kéo-thả; focus zoom + rail avatar bé; tidy tile lấp màn; tên agent sửa được. (Spec 2026-07-21, mockup đã duyệt)
  - [ ] src/canvas.ts: layout state (pos/size per pane), nextSlot, tileToFit(count→cols/rows), persist per-workspace
  - [ ] main.ts: .grid → .canvas; pane header bar là drag handle (Pointer Events, no HTML5 DnD)
  - [ ] focusPane/exitFocus thay toggleMax: FLIP zoom + đẩy pane khác vào rail avatar bé (thay display:none)
  - [ ] Định danh: PERSONA_NAMES pool trong crew.ts, nameForNewPane, rename inline → cập nhật MAESTRO_AGENT + board assignee
  - [ ] styles/canvas.css: pane glass, header bar, rail, focus stage, scrollbar auto-ẩn
  - [ ] Unit test: nextSlot/tileToFit không đè, uniqueness tên, FLIP rect helper
  - [ ] Verify live: spawn 2/4/6 agent, tidy, focus/rail, rename
- [x] Redesign P2: Command bar + @mention + voice + delegation
  Thay broadcast bar bằng command bar 1 dòng; @tên autocomplete; voice→AI phân việc; vẽ delegation khi agent giao nhau.
  - [ ] #bcast → command bar 1 dòng (⚙ · input · mic · send · +Agent); spawn menu số lượng/CLI/custom
  - [ ] src/mention.ts: parseMentions(@tên → stdin đúng pane), autocomplete
  - [ ] Voice: nhận diện giọng nói → transcript → AI tách task/agent → dispatch (tích hợp giống WakerVoice)
  - [ ] Delegation event từ maestro-mcp (fleet_send) → vẽ connector + feed trong Fleet panel
  - [ ] Unit test: parseMentions, dedup delegation
  - [ ] Verify live: @tên gửi đúng, voice dispatch, agent giao nhau hiện connector
- [x] Explorer P1: Realtime watcher + file-ops backend (Rust)
  Tree tự cập nhật khi agent/CLI đổi file trên đĩa; bổ sung các lệnh fs còn thiếu (copy/move/trash/reveal).
  - [ ] Cargo: thêm crate notify (debounced) + trash
  - [ ] core/watch.rs: watch_start(root)/watch_stop, recursive, debounce ~150ms, bỏ qua .git/node_modules/target
  - [ ] Emit event 'fs-changed' kèm danh sách thư mục (rel) bị đổi, coalesce trùng
  - [ ] fs_copy (đệ quy) + fs_move (khác thư mục, tự né trùng tên) trong core/fs.rs
  - [ ] fs_trash: xoá vào Recycle Bin, nhận NHIỀU path, fallback xoá vĩnh viễn
  - [ ] fs_reveal: mở File Explorer và chọn đúng item (reveal_item_in_dir)
  - [ ] Đăng ký commands trong lib.rs + capabilities cho opener
  - [ ] Unit test Rust: copy đệ quy, move né trùng tên, trash nhiều mục, watcher lọc noise
- [x] Explorer P2: UX kiểu VS Code (multi-select, phím, menu, toolbar)
  filetree.ts lên chuẩn VS Code: chọn nhiều, điều khiển bàn phím, context menu đầy đủ, toolbar header, icon theo loại file.
  - [ ] Model phẳng cho hàng đang hiện (rows[]) + state expanded/selected tách khỏi DOM
  - [ ] Multi-select: click, Ctrl+click toggle, Shift+click chọn dải; anchor như VS Code
  - [ ] Bàn phím: ↑↓ di chuyển, ←→ đóng/mở, Enter mở, F2 rename, Delete xoá, Esc bỏ chọn, Ctrl+A
  - [ ] Xoá nhiều: 1 hộp xác nhận liệt kê N mục → fs_trash một lần
  - [ ] Context menu: New file/folder, Reveal in File Explorer, Open in terminal here, Cut/Copy/Paste, Duplicate, Copy path / Copy relative path, Rename, Delete
  - [ ] Toolbar trong header Explorer: new file, new folder, refresh, collapse all, hiện file ẩn (bỏ const showHidden=false)
  - [ ] Ô lọc nhanh (type-to-filter) trong panel
  - [ ] Icon theo đuôi file kiểu VS Code + màu; giữ ngôn ngữ thiết kế hiện có
  - [ ] Nhớ trạng thái mở/chọn theo workspace (localStorage) + auto-reveal file đang mở trong editor
  - [ ] Unit test: reducer select (ctrl/shift), flatten rows, expanded persist
- [x] Explorer P3: Kéo-thả di chuyển + đồng bộ editor
  Kéo (nhiều) mục thả vào thư mục để move — bằng Pointer Events; rename/delete/move phải cập nhật tab editor đang mở.
  - [ ] Drag nội bộ bằng Pointer Events (KHÔNG HTML5 DnD — WebView2 nuốt event)
  - [ ] Kéo được nhiều mục đang chọn; ghost đếm số mục; highlight thư mục đích, auto-expand khi hover ~600ms
  - [ ] Thả → fs_move; chặn thả vào chính nó/con của nó; Ctrl giữ = copy
  - [ ] Giữ nguyên drag ra terminal (path → PTY) như hiện tại
  - [ ] Editor: file đang mở bị rename/move → đổi đường dẫn; bị xoá → đóng tab/báo
  - [ ] Verify live trong app Tauri + screenshot review (dark/light)
