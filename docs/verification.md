# Kiểm chứng Notification — 17/11/2026

Cấu hình bàn giao: Supabase thật + RabbitMQ Docker + Mailpit. Đã bỏ bộ demo PostgreSQL local; chỉ dùng compose.yaml ở repo root.

- Build, TypeScript, ESLint, Prettier và 4 unit test đạt.
- Integration qua Gateway thật với JWT kiểm thử và PostgreSQL nhúng đạt cả 6 API; kiểm tra ownership, preferences snapshot, mark-read, validation, stale email skip, SMTP retry/success và lease recovery.
- RabbitMQ thật: duplicate, retry hữu hạn, poison message vào DLQ và publisher-confirm/unroutable đạt. Tài nguyên test có prefix riêng.
- Supabase thật: bootstrap/quyền app-migrator/TLS CA và 2 migration đạt. Live/ready HTTP 200, API thiếu token trả 401.
- Event tổng hợp gửi hai lần qua broker local tạo đúng một job SENT và một history Tracking; Mailpit nhận email handoff@example.test. Booking kiểm tra: b133be9d-4c7b-414f-9aba-e8966976ce84.
- Kiểm tra outage trước khi dọn bộ demo: tắt Notification, Tracking vẫn xử lý và queue giữ backlog; bật lại Notification, backlog về 0 và email SENT.
- Image chạy uid 1000, không chứa .env/.env.bootstrap/key; key/CA được mount lúc runtime.

Chưa chứng nhận login Auth thật, E2E với Booking/Operations/frontend, concurrency nhiều tiến trình, HA, kiến trúc CPU khác hoặc chạy trên máy người nhận. SMTP at-least-once vẫn có thể gửi trùng khi crash sau send. Image ứng dụng được build local từ source, không phụ thuộc tài khoản hoặc kho image cá nhân.

Hướng dẫn cấu hình, bootstrap, build và chạy ở [README](../README.md).

Cấu hình Compose đã được kiểm tra: build image local, bootstrap qua profile setup, migration tự chạy và thoát code 0, hai container healthy trên cổng 3005/3004, network chung tablebooking-user3. Event gửi trùng tạo một job SENT, một history và email cleanup@example.test trong Mailpit. Không push.
