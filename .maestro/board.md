# Board

## Proposed (3)

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

## Done (0)

_(empty)_
