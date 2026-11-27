# TIN LAB – Hướng dẫn Triển khai Giai đoạn 1 trên Cloudflare Workers + Neon PostgreSQL Free

Tài liệu này mô tả chi tiết các bước cấu hình cơ sở dữ liệu **Neon PostgreSQL Free**, **Worker Secrets**, **Firebase Authorized Domains**, **sao lưu / khôi phục dữ liệu** và **xuất bản lên Cloudflare Workers** cho TIN LAB (phục vụ 10–40 học sinh truy cập và làm bài đồng thời).

---

## 1. Kiến trúc Giai đoạn 1

- **Frontend**: React + TypeScript + Vite (`dist/client`) phục vụ qua Cloudflare Static Assets với SPA fallback cho `/`, `/hoc-sinh`, `/giao-vien`, `/thong-ke`, `/huong-dan`, `/lien-he`.
- **Backend API**: Cloudflare Worker (`worker/index.ts`) chạy trước Static Assets cho mọi đường dẫn `/api/*` (`run_worker_first: ["/api/*"]`).
- **Cơ sở dữ liệu**: Neon PostgreSQL Free qua **`@neondatabase/serverless` WebSocket `Pool` + `drizzle-orm/neon-serverless`** (hỗ trợ đầy đủ PostgreSQL ACID Transaction `BEGIN` / `SELECT ... FOR UPDATE` / `COMMIT` cho nộp bài chống trùng và duyệt điểm đồng thời; đóng kết nối sạch sau mỗi request, không dùng Cloud SQL socket).
- **Xác thực Super Admin**: Firebase Google Auth ở frontend + xác minh chữ ký Firebase ID Token bằng Web Crypto / JWKS (`jose`) trên Worker + kiểm tra `email_verified === true` và danh sách Super Admin cố định phía máy chủ:
  - `sunghiep.tsbd@gmail.com`
  - `secret1990.tsbd@gmail.com`
- **Chức năng tạm hoãn (Giai đoạn 2 — vẫn giữ nguyên mã nguồn gốc)**: Upload DOCX/PDF, AI Agent tách câu hỏi/xử lý ngoại lệ, Google Drive Document Library, xuất `.xlsx` nâng cao và gửi email SMTP.

---

## 2. Tạo Neon PostgreSQL Free & Chạy Migration an toàn

1. Đăng nhập [Neon Console](https://console.neon.tech) và tạo Project mới (chọn region gần Việt Nam, ví dụ **AWS Asia Pacific (Singapore) `ap-southeast-1`**).
2. Lấy **Connection String** (dạng Pooled hoặc Direct có `?sslmode=require`), ví dụ:
   ```text
   postgresql://<user>:<password>@<endpoint>.ap-southeast-1.aws.neon.tech/neondb?sslmode=require
   ```
3. Chạy tệp migration an toàn (chỉ dùng `CREATE TABLE IF NOT EXISTS` và `CREATE INDEX IF NOT EXISTS`, **không xóa bảng, không ghi đè dữ liệu**):
   - **Cách A (CLI từ dự án)**:
     ```bash
     DATABASE_URL="postgresql://<user>:<password>@<endpoint>.neon.tech/neondb?sslmode=require" npm run db:migrate:neon
     ```
   - **Cách B (Neon SQL Editor)**:
     Mở tệp `migrations/0001_neon_core_schema.sql`, sao chép toàn bộ nội dung và chạy trong Neon SQL Editor.

---

## 3. Cấu hình Worker Secrets (Tuyệt đối không commit vào Git)

### 3.1. Chạy thử trên máy cục bộ
Sao chép `.dev.vars.example` thành `.dev.vars` (đã có trong `.gitignore`) và điền giá trị thực:
```bash
cp .dev.vars.example .dev.vars
```
Các biến cần điền:
- `DATABASE_URL`: Connection String của Neon PostgreSQL (`?sslmode=require`).
- `FIREBASE_PROJECT_ID`: `gen-lang-client-0046593083`
- `EXAM_SEALING_SECRET`: Chuỗi bí mật ngẫu nhiên tối thiểu 32 ký tự để niêm phong và giải mã đáp án đề thi bằng AES-256-GCM. Tạo bằng:
  ```bash
  openssl rand -hex 32
  ```
  > **Lưu ý quan trọng**: Nếu bạn đã xuất bản đề thi trước đây trên Cloud Run với một giá trị `EXAM_SEALING_SECRET` cụ thể, hãy dùng **cùng giá trị `EXAM_SEALING_SECRET` đó** để các đề thi cũ vẫn giải mã và chấm điểm được bình thường.

### 3.2. Cấu hình Secrets trên Cloudflare Workers (Production)
Đăng nhập Cloudflare CLI một lần:
```bash
npx wrangler login
```
Nạp từng Secret trực tiếp lên Cloudflare (không lưu trong mã nguồn hay `wrangler.jsonc`):
```bash
npx wrangler secret put DATABASE_URL
npx wrangler secret put FIREBASE_PROJECT_ID
npx wrangler secret put EXAM_SEALING_SECRET
```
Hoặc vào **Cloudflare Dashboard → Workers & Pages → `tin-lab` → Settings → Variables and Secrets → Add (Type: Secret)**.

---

## 4. Thêm tên miền Cloudflare vào Firebase Authentication

Để nút **"Đăng nhập bằng Google"** tại `/giao-vien` hoạt động trên tên miền thật:
1. Mở [Firebase Console](https://console.firebase.google.com) → chọn project `gen-lang-client-0046593083`.
2. Vào **Authentication → Settings → Authorized domains**.
3. Nhấn **Add domain** và thêm tên miền Worker của bạn:
   ```text
   tin-lab.<tai-khoan>.workers.dev
   ```
   (và thêm tên miền riêng nếu có, ví dụ `tinlab.truong.edu.vn`).

---

## 5. Build, Kiểm thử Cục bộ & Chịu tải (10 / 20 / 40 người dùng)

1. Kiểm tra TypeScript (frontend + worker) và build sản phẩm:
   ```bash
   npm run build
   ```
2. Chạy thử local Worker + Frontend trên cổng 3000:
   ```bash
   npm run dev
   ```
3. Kiểm tra healthcheck (xác nhận `databaseConnected: true`, `examSealingSecretConfigured: true`):
   ```bash
   curl http://127.0.0.1:3000/api/health
   ```
4. Chạy bộ kiểm thử bảo mật & E2E (tự động kiểm tra giao dịch ghi/đọc Neon khi có `.dev.vars`):
   ```bash
   npx tsx scripts/verify-worker-e2e.mjs
   ```
5. Chạy kiểm thử tải đồng thời 10 / 20 / 40 yêu cầu:
   ```bash
   npm run test:load
   ```

---

## 6. Kết nối GitHub `tin_lab` và Triển khai lên Cloudflare Workers

### Cách A: Kết nối Git trực tiếp trên Cloudflare Dashboard (Khuyến nghị)
1. Đẩy mã nguồn đã kiểm tra lên nhánh mong muốn trong repository GitHub `tin_lab` (đảm bảo `.dev.vars` và `.env` không bị commit).
2. Đăng nhập [Cloudflare Dashboard](https://dash.cloudflare.com) → **Compute (Workers) → Workers & Pages → Create → Import a repository**.
3. Chọn repository GitHub **`tin_lab`** và nhánh triển khai.
4. Cấu hình Build Settings:
   - **Project / Worker name**: `tin-lab`
   - **Build command**: `npm run build`
   - **Deploy command**: `npx wrangler deploy`
   - **Root directory**: `/`
5. Trước khi mở cho học sinh, vào **Settings → Variables and Secrets** và khai báo đủ 3 **Secret**: `DATABASE_URL`, `FIREBASE_PROJECT_ID`, `EXAM_SEALING_SECRET`.
6. Thêm tên miền `tin-lab.<tai-khoan>.workers.dev` vào Firebase Authorized domains (Mục 4).

### Cách B: Triển khai thủ công bằng Wrangler CLI
```bash
npx wrangler login
npm run cf:deploy
```

URL dự kiến sau khi triển khai thành công:
```text
https://tin-lab.<tai-khoan>.workers.dev
```

Kiểm tra nhanh sau deploy:
1. Mở `https://tin-lab.<tai-khoan>.workers.dev/api/health` → xác nhận `ok: true`, `databaseConnected: true`.
2. Mở `/hoc-sinh`, khai báo Họ tên + Lớp, làm bài, nộp bài và kiểm tra điểm trả về.
3. Mở `/giao-vien`, đăng nhập bằng `sunghiep.tsbd@gmail.com` hoặc `secret1990.tsbd@gmail.com`, kiểm tra bài làm vừa nộp và tải tệp CSV (mở bằng Microsoft Excel kiểm tra hiển thị tiếng Việt có dấu).

---

## 7. Sao lưu và Khôi phục dữ liệu Neon PostgreSQL

### Sao lưu định kỳ (khuyến nghị trước và sau mỗi đợt kiểm tra)
```bash
pg_dump "$DATABASE_URL" --format=custom --no-owner --no-acl -f "tin-lab-backup-$(date +%Y%m%d-%H%M).dump"
```

### Khôi phục khi cần thiết (nên khôi phục thử sang một Neon Branch mới trước)
```bash
pg_restore --dbname="$TARGET_DATABASE_URL" --no-owner --no-acl --clean --if-exists "tin-lab-backup-YYYYMMDD-HHMM.dump"
```

Ngoài ra, Neon Free hỗ trợ **Instant Branching / Point-in-Time Restore** trong bảng điều khiển Neon để tạo nhanh bản sao kiểm thử trước mọi thao tác thay đổi dữ liệu.
