# Notification service

Nhận `booking.state-changed.v1`, lưu thông báo vào Supabase và gửi email demo qua Mailpit.

## Yêu cầu

- Cài Docker Desktop, bật Linux containers và dùng Docker Compose v2.24+.
- Cài Git để clone hoặc cập nhật repo.
- Chuẩn bị project Supabase và public key RSA từ service Auth.
- Chạy bằng Docker thì không cần cài Node trên máy.

## Cấu hình

Mở PowerShell trong thư mục `notification-service` vừa clone hoặc cập nhật.

### 1. Tạo file và thư mục

```powershell
if (!(Test-Path .env)) { Copy-Item .env.example .env }
New-Item -ItemType Directory -Force keys, certs | Out-Null
```

### 2. Điền .env

- Điền `DATABASE_URL` cho role `notification_app` và `MIGRATION_DATABASE_URL` cho role `notification_migrator` của đúng project Supabase.
- Dùng thông tin kết nối Session pooler của project: host, project ref, cổng `5432`, database `postgres`. URL-encode phần password; không thêm tham số `sslmode`, `sslrootcert`, `sslkey`, `sslcert` vào URL.
- Giữ `DB_SSL_ENABLED=true`, `DB_SSL_CA_PATH=./certs/supabase-ca.crt` và `JWT_PUBLIC_KEY_PATH=./keys/auth-public.pem`.
- Giữ `JWT_ISSUER=restaurant-auth` và `JWT_AUDIENCE=restaurant-api` khớp token Auth.
- Đặt `RABBITMQ_USER` và `RABBITMQ_PASSWORD`. Dùng password dài bằng chữ, số, `-`, `_`; dùng cùng username/password trong `RABBITMQ_URL` với host `localhost`, cổng `5675`.
- Giữ `DELIVERY_WORKER_ENABLED=true` và cấu hình Mailpit: `SMTP_HOST=localhost`, `SMTP_PORT=1025`, `SMTP_SECURE=false`, `SMTP_REQUIRE_TLS=false`; để trống `SMTP_USER`, `SMTP_PASSWORD`.
- Giữ `NODE_ENV=development` khi dùng Mailpit; worker ở chế độ production yêu cầu tài khoản SMTP.

Compose tự đổi địa chỉ broker sang `rabbitmq:5672`, SMTP sang `mailpit` và đường dẫn key/CA sang đường dẫn container.

### 3. Đặt CA và public key

| File                    | Lấy ở đâu                                                                           |
| ----------------------- | ----------------------------------------------------------------------------------- |
| `certs/supabase-ca.crt` | Tải CA certificate của project từ phần cài đặt Database trên Supabase.              |
| `keys/auth-public.pem`  | Nhận public key RSA dạng PEM/SPKI, tối thiểu 2048 bit, từ service Auth đang ký JWT. |

Chỉ đặt public key RSA vào `auth-public.pem`; không dùng private key, Supabase anon key hoặc service-role key.

### 4. Bootstrap project mới

Chỉ làm bước này với project Supabase mới; bỏ qua nếu role/schema đã được bootstrap.

Tạo file cấu hình:

```powershell
if (!(Test-Path .env.bootstrap)) { Copy-Item .env.bootstrap.example .env.bootstrap }
```

Điền `BOOTSTRAP_DATABASE_URL` bằng kết nối quản trị của đúng project, với password đã URL-encode.

Đặt `APP_DB_PASSWORD` và `MIGRATOR_DB_PASSWORD` bằng password nguyên bản của hai role tương ứng trong `.env`.

Chạy bootstrap sau khi đặt CA:

```powershell
docker compose --profile setup run --rm --build bootstrap
```

## Chạy

Khởi động Notification **trước Tracking** vì repo này tạo network `tablebooking-user3` và RabbitMQ có hostname `rabbitmq`.

1. Build image từ source:

   ```powershell
   docker compose build
   ```

2. Khởi động các service:

   ```powershell
   docker compose up -d --no-build --wait
   ```

3. Kiểm tra trạng thái container:

   ```powershell
   docker compose ps -a
   ```

Migration chạy trước ứng dụng; container `migrate` thoát code `0` là bình thường.

## Kiểm tra

Mở các địa chỉ mặc định sau:

| Thành phần             | Địa chỉ                                      |
| ---------------------- | -------------------------------------------- |
| API                    | http://localhost:3005/api/notifications/mine |
| Liveness               | http://localhost:3005/health/live            |
| Readiness              | http://localhost:3005/health/ready           |
| RabbitMQ Manager       | http://localhost:15675                       |
| AMQP cho Node trên máy | `localhost:5675`                             |
| Mailpit UI             | http://localhost:8025                        |

Kiểm tra hai health endpoint trả HTTP `200`. Đăng nhập RabbitMQ Manager bằng `RABBITMQ_USER`/`RABBITMQ_PASSWORD` trong `.env`. Mở Mailpit để xem email demo sau khi xử lý event.

## API

Gửi header `Authorization: Bearer <JWT>` với JWT RS256 có `iss=restaurant-auth`, `aud=restaurant-api`. Mỗi người chỉ thao tác thông báo và preferences của mình.

| Method | Path                              |
| ------ | --------------------------------- |
| GET    | `/api/notifications/mine`         |
| GET    | `/api/notifications/unread-count` |
| POST   | `/api/notifications/:id/read`     |
| POST   | `/api/notifications/read-all`     |
| GET    | `/api/notifications/preferences`  |
| PATCH  | `/api/notifications/preferences`  |

## Dừng

Dừng Tracking trước nếu đang dùng chung broker. Sau đó dừng các container trong repo này:

```powershell
docker compose stop
```

## Test

Cài Node 24 (`>=24.15.0 <25`). Chạy trong thư mục repo:

```powershell
npm.cmd ci
npm.cmd run check
npm.cmd test
npm.cmd run test:integration
npm.cmd run build
```

Để chạy `test:gateway`, chuẩn bị repo `Api-gateway` nằm cạnh repo này, đã cài dependencies và build, có `../Api-gateway/dist/bootstrap.js`. Test tự khởi động Gateway trên cổng tạm.

```powershell
npm.cmd run test:gateway
```

Để chạy `test:broker`, khởi động RabbitMQ development của Notification và điền đúng `RABBITMQ_URL` trong `.env`. Nạp URL vào `BROKER_TEST_URL`; test dùng queue/exchange có prefix riêng.

```powershell
$env:BROKER_TEST_URL = node --env-file=.env -p "process.env.RABBITMQ_URL"
npm.cmd run test:broker
Remove-Item Env:BROKER_TEST_URL
```

Xem phạm vi và giới hạn kiểm chứng tại [docs/verification.md](docs/verification.md).

## Lỗi thường gặp

| Triệu chứng                                     | Cách xử lý                                                                                                                                                                                                                      |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Cổng `3005` bị chiếm                            | Dừng tiến trình Node đang chiếm cổng trước khi chạy container.                                                                                                                                                                  |
| PowerShell chặn `npm.ps1`                       | Dùng `npm.cmd` như các lệnh ở trên.                                                                                                                                                                                             |
| Git báo dubious ownership                       | Chạy lệnh Git bên dưới trong thư mục repo.                                                                                                                                                                                      |
| DB báo lỗi TLS/CA                               | Kiểm tra `certs/supabase-ca.crt` thuộc đúng project và giữ `DB_SSL_ENABLED=true`.                                                                                                                                               |
| `migrate` báo lỗi quyền                         | Với project mới, bootstrap đúng project bằng tài khoản quản trị; kiểm tra hai role và URL DB.                                                                                                                                   |
| RabbitMQ từ chối đăng nhập sau khi đổi password | Đổi `.env` không đổi tài khoản đã lưu trong volume `notification_rabbitmq` (tên mặc định: `notification-service_notification_rabbitmq`). Dùng tài khoản hiện có để cập nhật password trên broker rồi đồng bộ cấu hình hai repo. |
| Container chưa sẵn sàng                         | Xem log ứng dụng và migration bằng lệnh bên dưới.                                                                                                                                                                               |

Xem log:

```powershell
docker compose logs --tail=100 notification migrate
```

Nếu Git báo dubious ownership, chạy:

```powershell
$repoPath = (Get-Location).Path.Replace('\', '/')
git -c safe.directory="$repoPath" status
```

## Lưu ý

- Giữ kín `.env`, `.env.bootstrap` và private key; chỉ chia sẻ file mẫu.
- Bootstrap không tự đổi password của role đã tồn tại.
- Email có cơ chế at-least-once: crash sau khi gửi SMTP nhưng trước khi đánh dấu `SENT` có thể gửi trùng.

## Nâng cao

Để tạo sẵn cả hai lifecycle queue trước khi phát event, dùng Node 24 và dependencies đã cài ở mục Test. Chỉ khởi động broker và Mailpit, rồi provision:

```powershell
docker compose up -d --wait rabbitmq mailpit
npm.cmd run provision:broker
```

Để gửi qua SMTP thật, điền cấu hình nhà cung cấp vào `.env`, bỏ override `SMTP_HOST: mailpit` trong `compose.yaml`, rồi chạy lại bước khởi động service.
