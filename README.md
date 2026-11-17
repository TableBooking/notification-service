# Notification service

Nhận `booking.state-changed.v1`, lưu thông báo và gửi email demo vào Mailpit. Database nằm trên **Supabase**; Compose chỉ chạy ứng dụng, migration, RabbitMQ và Mailpit. Không có PostgreSQL local hay bộ deploy/demo.

## Chuẩn bị Supabase và Auth

Chỉ cần Docker Desktop chạy Linux containers, Docker Compose v2.24+ và Git để lấy source; không cần cài Node nếu chạy bằng Docker.

1. Copy `.env.example` thành `.env` **chỉ khi chưa có file**. Không copy đè file đã điền.
2. Trong Supabase chọn **Connect → Session pooler**, dùng host được cung cấp, port `5432`, database `postgres`. Điền project ref và password đã URL-encode vào hai URL DB; không thêm `sslmode` vào URL.
3. Tải CA certificate của project vào `certs/supabase-ca.crt`.
4. Nhận public key RSA từ Auth và đặt tại `keys/auth-public.pem`. Không dùng private key, Supabase anon key hay service-role API key.
5. Nếu role/schema đã được bootstrap thì bỏ qua bước tạo DB dưới đây. Nếu là project mới, copy `.env.bootstrap.example` thành `.env.bootstrap`; điền URL quản trị và tự đặt hai mật khẩu app/migrator. Mật khẩu trong hai biến riêng là nguyên bản; mật khẩu trong URL phải URL-encode.

Bootstrap cấp quyền thành viên migrator cho tài khoản quản trị để gán schema owner trên Supabase. Script không tự đổi mật khẩu role đã tồn tại. Không commit hoặc chia sẻ `.env`/`.env.bootstrap` thật.

## Chạy từ source vừa clone/pull

Trong thư mục `notification-service`:

```powershell
Copy-Item .env.example .env
New-Item -ItemType Directory -Force keys, certs
```

Điền cấu hình và đặt key/CA như trên. Nếu DB mới:

```powershell
Copy-Item .env.bootstrap.example .env.bootstrap
# Dien file bootstrap truoc khi chay:
docker compose --profile setup run --rm --build bootstrap
```

Build và chạy:

```powershell
docker compose build
docker compose up -d --no-build --wait
docker compose ps -a
```

Migration tự chạy trước ứng dụng. Container `migrate` thoát code 0 là bình thường. DB đã tạo rồi không cần chạy bootstrap lại. Dừng bản Node đang chiếm cổng 3005 trước khi chạy container.

| Thành phần             | Địa chỉ                            |
| ---------------------- | ---------------------------------- |
| Readiness              | http://localhost:3005/health/ready |
| Liveness               | http://localhost:3005/health/live  |
| RabbitMQ Manager       | http://localhost:15675             |
| Mailpit                | http://localhost:8025              |
| AMQP cho Node trên máy | localhost:5675                     |

Đăng nhập RabbitMQ bằng `RABBITMQ_USER`/`RABBITMQ_PASSWORD` trong .env. Khi tạo broker mới, đặt password dài bằng chữ/số/`-`/`_` và dùng cùng password trong RABBITMQ_URL. Đổi env không tự đổi tài khoản đã lưu trong volume.

## Chạy cùng Tracking

Notification tạo Docker network `tablebooking-user3` và broker có hostname `rabbitmq`. Khởi động repo này trước, rồi chạy Tracking theo README của repo đó. Hai service dùng cùng broker/vhost, mỗi service có queue riêng. Không cần chạy broker Operations/Booking/infrastructure để thử hai service này.

Khi chỉ chạy broker trước, tạo cả hai lifecycle queue trước khi phát event:

```powershell
docker compose up -d rabbitmq mailpit
# Lenh duoi can Node 24 va npm ci, chi dung neu chua chay hai consumer:
npm.cmd run provision:broker
```

Khi hai ứng dụng đã chạy, chúng tự khai báo queue/retry/DLQ. Mailpit giữ email để xem trong trình duyệt, không gửi vào Gmail thật. Để gửi email thật sau này, thay SMTP provider và bỏ override `SMTP_HOST: mailpit` trong Compose.

## Pull image có sẵn

Compose đặt tên image mặc định `bao11/notification-service:0.1.0`. **Image chưa được publish trong lần bàn giao này.** Hiện tại dùng hướng build source ở trên; không thể pull tag chưa tồn tại.

Sau khi chủ repo publish tag này, người nhận vẫn cần file Compose, .env riêng, CA và public key, rồi chạy:

```powershell
docker compose pull notification migrate
docker compose up -d --no-build --wait
```

Có thể đặt `NOTIFICATION_IMAGE` trong .env để dùng tag khác. Repository image private cần `docker login`. Không có credentials nào được đóng trong image. Các thay đổi Git cũng mới ở main local, chưa push; người nhận chỉ pull được sau khi chủ repo phát hành.

## API và kiểm tra

Cả 6 endpoint cần Bearer JWT RS256 đúng Auth (`iss=restaurant-auth`, `aud=restaurant-api`). Mỗi người chỉ thao tác thông báo của chính mình.

| Method | Path                            |
| ------ | ------------------------------- |
| GET    | /api/notifications/mine         |
| GET    | /api/notifications/unread-count |
| POST   | /api/notifications/:id/read     |
| POST   | /api/notifications/read-all     |
| GET    | /api/notifications/preferences  |
| PATCH  | /api/notifications/preferences  |

Chạy Node để phát triển: `npm ci`, `npm run build`, `npm start`. .env dùng hostname localhost; Compose tự đổi broker/SMTP/key/CA sang đường dẫn container. Không chạy Node và container ứng dụng cùng cổng.

```powershell
npm.cmd run check
npm.cmd test
npm.cmd run test:integration
npm.cmd run test:gateway
npm.cmd run build
```

Test gateway cần repo Api-gateway cạnh repo này, đã cài dependencies và build. Test broker: đặt BROKER_TEST_URL tới broker development, rồi `npm run test:broker`; test dùng prefix riêng, không reset broker. Kết quả và giới hạn đã kiểm chứng: [docs/verification.md](docs/verification.md).

Dừng bằng `docker compose stop`, xem lỗi bằng `docker compose logs --tail=100 notification migrate`. Không xóa volume để sửa lỗi đăng nhập. Email có giới hạn at-least-once: crash sau SMTP trước mark SENT có thể gửi trùng; inbox chỉ chống lặp xử lý event.
