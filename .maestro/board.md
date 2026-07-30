# Board

## Proposed (7)

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
- [ ] Canvas P1: Terminal trong suốt — chỉ còn chữ trên nền
  Bỏ nền đục #0b0d12 của xterm để ảnh nền workspace xuyên qua; auto đảo màu chữ theo độ sáng nền + cho chỉnh tay. Bẫy: WebGL không blend transparent → về #000, phải ép DOM renderer.
  - [ ] terminal.ts: allowTransparency + theme.background trong suốt (thay '#0b0d12' ở dòng 129)
  - [ ] KHÔNG attach WebglAddon cho pane trong suốt — tái dùng đường DOM renderer sẵn có (WEBGL_BUDGET / onContextLoss, terminal.ts:169-203); ghi comment lý do + đo lại perf 4 pane
  - [ ] Nền do AI CLI tự vẽ (ANSI SGR): chọn A) knockout map màu nền tối → transparent, hay B) chấp nhận chỉ ăn với CLI dùng default-bg. Ghi rõ chọn gì, mất highlight nào
  - [ ] Auto contrast: tính luminance nền (preset/màu/sample ảnh) → đảo TOÀN BỘ ANSI 16 giữa bảng chữ-tối và chữ-sáng, không chỉ foreground
  - [ ] Manual override trong Settings: light / dark / auto, lưu per-workspace cạnh background spec
  - [ ] Sàn dễ đọc trên ảnh rối: text-shadow hoặc scrim/backdrop-filter mỏng sau lớp chữ; đo contrast ratio (mục tiêu >=7:1, không dưới 4.5:1)
  - [ ] Cursor, selection highlight, ring pane focus phải còn thấy ở cả 2 theme
  - [ ] Slider opacity per-workspace trong Settings → Appearance (mặc định 0 = trong suốt hẳn)
  - [ ] Test: logic chọn theme theo luminance; tsc + suite hiện có xanh
  - [ ] Verify live: chụp claude VÀ opencode trên nền ảnh sáng + preset tối
- [ ] Canvas P2: Pane dính liền nhau, gap = 0
  Các cửa sổ AI sát nhau thành một mặt liền, không chừa khoảng hở. Hiện tileToFit dùng gap:12, margin:18, top/bottom:16 và bo góc 12px (giả định có gap).
  - [ ] canvas.ts tileToFit: gap 12 → 0; cân lại margin/top/bottom (viền ngoài có thể giữ inset nhỏ, pane-với-pane phải liền)
  - [ ] Ranh giới giữa 2 pane chỉ là seam 1px, không hở nền; không để khe màu nền ở góc nơi 4 pane giáp nhau
  - [ ] canvas.css: sửa border-radius (dòng 29) — bo góc ngoài hoặc bỏ hẳn, góc trong vuông
  - [ ] Vẫn kéo/resize/nhận diện được từng pane; pane đang focus phải nổi rõ khi không còn gap
  - [ ] canvas.test.ts: cập nhật expectation cho tileToFit (sửa, không xoá test)
  - [ ] Verify live: 2 / 4 / 6 pane, kiểm tra không lộ khe và không chồng lấn
- [ ] Canvas P3: Zoom giữ 4 pane còn đọc được
  Density zoom: Ctrl+scroll / Ctrl +,-,0 đổi cỡ chữ hiệu dụng và tile fit lại. Phải thắng auto-fit nudge (AUTO_FIT_DROP=4) chứ không đánh nhau với nó.
  - [ ] Zoom control: Ctrl/Cmd + scroll, Ctrl +/-/0, và một nút thấy được trên canvas
  - [ ] Lưu mức zoom per-workspace như layout
  - [ ] Density zoom: đổi font size hiệu dụng rồi re-fit cols/rows — KHÔNG CSS-scale (chữ sẽ mờ)
  - [ ] PTY resize bám theo mọi thay đổi: không cụt prompt, không loạn scrollback
  - [ ] Thứ tự ưu tiên rõ trong code + comment: zoom (ý người dùng) thắng auto-fit shrinkToFit/AUTO_FIT_DROP — nhắc commit bb959d2 vì sao có cap
  - [ ] Test: precedence zoom vs auto-fit; suite terminal/pane hiện có xanh
  - [ ] Acceptance: 4 pane tile trên cửa sổ 1080p, zoom mặc định đọc thoải mái

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

## Done (7)

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
- [x] Fix pane terminal quá ít dòng khi 3-4 agent
  Tile 2x2 chỉ ra ~12 dòng: tileToFit chừa đáy 84px chồng lên padding 56px của .main, padding .xterm dày, và font không co theo pane.
  - [ ] canvas.ts: bỏ double-reserve đáy (bottom 84 → 16) + test
  - [ ] workspace.css: .xterm padding 14/16 → 8/12, mask fade khớp 8px
  - [ ] terminal.ts: shrinkToFit + auto co font theo tile (target ~24 dòng, sàn 10px)
  - [ ] pane.ts: bật auto-fit cho mọi pane; focus/exit vẫn đổi base font
  - [ ] Test + tsc + build xanh
