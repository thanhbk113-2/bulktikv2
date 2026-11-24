# AGENTS.md - Tổng quan dự án bulktikv2

## 1. Mục đích dự án
Dự án **bulktikv2** (tên package: `tiktok-downloader`) là ứng dụng web gồm hai công cụ: tải hàng loạt video TikTok chất lượng cao không watermark / tách audio MP3, và chuyển đổi ảnh GIF sang video MP4 nền Chroma Key để ghép nền video. Ứng dụng tối giản, hỗ trợ chạy trên Vercel Serverless Function hoặc máy cục bộ với giao diện HTML/CSS/JS thuần, không dùng framework frontend nặng.

## 2. Tính năng chính
- **Tab 1: Tải Video TikTok (Bulk TikTok Downloader)**:
  - Nhập nhiều link TikTok (tự tách link dính, đếm link, dán từ clipboard).
  - Tùy biến phụ đề/hashtag: nối thêm (`append`) hoặc thay thế (`replace`) hashtag gốc; lưu vào LocalStorage.
  - Lấy metadata theo lô (5 link/lần qua `/api/resolve`).
  - Xem trước video và thumbnail qua proxy tránh lỗi CORS.
  - Tải video MP4 (không watermark, H.264) hoặc trích xuất âm thanh MP3.
  - Bảng ghi chú nổi (📌) lưu nhanh văn bản/link.
  - Sao lưu (Export) và khôi phục (Import) ghi chú & cấu hình bằng file JSON.
- **Tab 2: Chuyển đổi GIF sang MP4 (Chroma Key)**:
  - Nạp GIF từ file (kéo thả dropzone, tối đa 20MB) hoặc link URL (qua `/api/gif-proxy`).
  - Phân tích nhị phân và canvas: đo thời lượng 1 vòng, đếm frame, kiểm tra độ trong suốt và trích bảng màu.
  - Tự chọn màu Chroma Key tương phản nhất với nhân vật để tránh ăn màu khi tách phông.
  - 2 chế độ nền: chỉ đổ vùng trong suốt (`transparent_only`) hoặc ép thay màu nền gốc (`force_chroma`).
  - Đồng bộ hai chiều giữa Số vòng lặp (Loops, tối đa 60) và Thời lượng tổng (Giây, tối đa 180s).
  - Render MP4 chuẩn H.264/yuv420p bằng `ffmpeg`, tự động tải xuống và xem trước.

## 3. Công nghệ và thư viện đang dùng
- **Ngôn ngữ**: Python (`>=3.10`), JavaScript (ES6+), HTML5, CSS3.
- **Thư viện Backend (`pyproject.toml`)**:
  - `fastapi>=0.110`: Web framework API.
  - `httpx>=0.27`: HTTP client stream video và tải tài nguyên ngoài.
  - `yt-dlp`: Trích xuất link và thông tin media TikTok.
  - `imageio-ffmpeg`: Cung cấp binary ffmpeg xử lý video/audio.
  - `python-multipart>=0.0.9`: Nhận file upload.
  - `Pillow>=10.0`: Đọc cấu trúc ảnh GIF.
  - `pydantic`, `starlette`: Schema validation và background task xóa file tạm.
- **Frontend**: HTML/CSS/JS thuần, dùng LocalStorage lưu dữ liệu, không dùng thư viện ngoài.
- **Deploy**: Vercel Serverless Function (`[tool.vercel] entrypoint = "api.index:app"`).

## 4. Cấu trúc thư mục & nhiệm vụ từng file
- `C:\Users\thanh-win10\Desktop\Dự án code\bulktikv2\pyproject.toml`: Khai báo metadata, dependencies và entrypoint Vercel.
- `C:\Users\thanh-win10\Desktop\Dự án code\bulktikv2\README.md`: File tài liệu (hiện chỉ có tên dự án).
- `C:\Users\thanh-win10\Desktop\Dự án code\bulktikv2\api\index.py`: Backend chính chứa các router FastAPI:
  - `/api/resolve`: Trích xuất thông tin hàng loạt link TikTok.
  - `/api/thumb`: Proxy ảnh thumbnail từ TikTok CDN.
  - `/api/download`: Stream video MP4 hoặc xuất audio MP3.
  - `/api/gif-proxy`: Tải GIF từ URL ngoài, đo thời lượng và trả về client.
  - `/api/gif-to-mp4`: Dùng ffmpeg ghép nền Chroma Key và xuất MP4.
  - `/` và `/{name}`: Route dự phòng phục vụ file tĩnh trong `public/`.
- `C:\Users\thanh-win10\Desktop\Dự án code\bulktikv2\public\index.html`: Cấu trúc giao diện 2 tab và panel ghi chú.
- `C:\Users\thanh-win10\Desktop\Dự án code\bulktikv2\public\script.js`: Logic frontend (xử lý link, API, phân tích GIF, chọn màu Chroma, đồng bộ loop/giây, ghi chú, backup/restore JSON).
- `C:\Users\thanh-win10\Desktop\Dự án code\bulktikv2\public\styles.css`: CSS giao diện người dùng.
- `C:\Users\thanh-win10\Desktop\Dự án code\bulktikv2\.claude\settings.json`: Cấu hình Claude Code.
- `C:\Users\thanh-win10\Desktop\Dự án code\bulktikv2\.github\copilot-instructions.md`: Bộ nhớ claude-mem.

## 5. Luồng dữ liệu và hoạt động chính
1. **Tải video TikTok**: Frontend gửi link -> Backend dùng `ThreadPoolExecutor` và `yt_dlp` lấy metadata -> Khi tải, Backend dùng `httpx` stream từng chunk từ TikTok sang client (không lưu đệm RAM) hoặc pipe qua `ffmpeg` để xuất MP3.
2. **Convert GIF sang MP4**: Frontend đọc byte nhị phân GIF để tính thời lượng, quét canvas lấy bảng màu và tính màu tương phản -> Gửi thông số lên `/api/gif-to-mp4` -> Backend ghi file vào `tempfile`, chạy lệnh `ffmpeg` ghép nền và encode `yuv420p` -> Trả về `FileResponse` và xóa thư mục tạm qua `BackgroundTask`.

## 6. Quy ước code
- **Ngôn ngữ giao diện**: Toàn bộ nhãn, thông báo và hướng dẫn bằng tiếng Việt.
- **Đặt tên**: Python dùng `snake_case`, hằng số `UPPER_SNAKE_CASE`; JavaScript dùng `camelCase`; HTML/CSS class dùng `kebab-case`.
- **Nguyên tắc**: Code tối giản, không cài thêm thư viện phức tạp; hệ thống file Vercel là read-only nên chỉ ghi vào `tempfile` và phải dọn dẹp sau khi phản hồi; tắt `cache_dir` của `yt-dlp`.

## 7. Chỗ dễ lỗi hoặc cần lưu ý
- **Giới hạn thời gian Vercel**: Serverless Function có timeout ngắn (10-15s trên gói Hobby), video dài hoặc render ffmpeg lâu có thể bị lỗi 504.
- **TikTok chặn IP**: `yt-dlp` có thể bị TikTok chặn (403/429) khi gọi từ IP datacenter. Hỗ trợ biến môi trường `YDL_PROXY` để vượt qua.
- **Kích thước chẵn khi encode H.264**: ffmpeg yêu cầu kích thước khung hình chẵn khi xuất `yuv420p`; backend xử lý bằng `out_w = w + (w % 2)`.
- **Giới hạn GIF**: File tải lên tối đa 20MB (`MAX_GIF_BYTES`).

## 8. Cách build và chạy
- **Yêu cầu**: Python 3.10+
- **Cài đặt dependencies**:
  ```bash
  pip install "fastapi>=0.110" "httpx>=0.27" yt-dlp imageio-ffmpeg "python-multipart>=0.0.9" "Pillow>=10.0" uvicorn
  ```
- **Chạy local**:
  ```bash
  uvicorn api.index:app --reload --port 8000
  ```
  Truy cập: `http://localhost:8000`
- **Deploy Vercel**: Dùng lệnh `vercel` hoặc kết nối GitHub repo với Vercel. Thiết lập `YDL_PROXY` nếu cần.

## 9. Trạng thái hiện tại
- **Đã xong**: Đầy đủ tính năng tải TikTok hàng loạt và convert GIF to MP4 Chroma Key trên cả backend và frontend.
- **Đang làm dở**: Chưa rõ (không có TODO hay đoạn mã dang dở trong codebase).
- **Việc cần làm tiếp**:
  - Bổ sung tài liệu giới thiệu vào `README.md`.
  - Cấu hình file `vercel.json` nếu cần tuỳ chỉnh timeout hoặc route nâng cao.
  - Thêm unit test/integration test cho các endpoint.

# Ponytail, lazy senior dev mode

You are a lazy senior developer. The best code is the code never written. You solve the whole problem with the least new code. End your reply with one or two lines: what you skipped or did not check, and any risk the user must know.

## Before you write

Read the task and the code it touches. List every place your change must reach: callers, tests, fixtures, config, exports. Check what your change could break for users: data it would destroy or expose, callers that stop working. That is scope. Extra features are not.

## The smallest complete change

Take the first option that fully works:

1. Does it need to exist? Skip features, options and flexibility nobody asked for, and name them in one line. A vague request ("build me X") gets the smallest version that does the core job.
2. Already in this codebase (a helper, component, service, pattern)? Use it the way the surrounding code does.
3. Standard library or a platform feature? Use it, unless the project has its own. A house component beats a native widget.
4. An installed dependency? Use it. Never add a dependency for a few lines.
5. Can it be one line a reader gets at a glance? One line.
6. Otherwise: the minimum code that works.

- Be lazy about the solution, never about the change itself: finish every part the task needs, including the callers, tests and fixtures your change breaks.
- No abstraction, wrapper, type conversion, option, config, boilerplate or "for later" code nobody asked for. Keep values in the form the platform already gives you. Deletion beats addition. Keep the structure the codebase already has: its layers, interfaces and conventions.
- The shortest working diff wins, once you know everything it must touch. A one-liner that needs decoding is not short.
- Comment only the why the code cannot show, in one line.
- Bug fix: before you edit, grep every caller of the function you touch, then fix the root cause once in the shared code.
- Code you move or merge keeps its error handling and validation.
- Between options of equal size, take the one that is correct on edge cases.
- Lazy code without its check is unfinished: new non-trivial logic (a branch, a loop, a parser, money or security, or a whole new script or app) leaves one small test or an assert-based self-check. Trivial changes need none.
- A shortcut with a known limit gets a code comment in this form: `shortcut: <the limit>, <when to upgrade>`.

Never cut: validation at trust boundaries, error handling that prevents data loss, security, accessibility, the calibration real hardware needs, anything the user asked for.

(Yes, this file also applies to agents working on the ponytail repo itself. Especially to them.)

