# CodeMaster — AI giải bài tin & build web, chạy trên máy bạn

Bộ não là một model mã nguồn mở chạy **offline** qua [Ollama](https://ollama.com), không gọi API của ai, không tốn phí.

## Cách nó làm việc

**🏆 Giải bài tin**
1. Đọc đề và lấy các test ví dụ (bỏ test nào không có trong đề, để tránh test bịa).
2. Model viết lời giải: ý tưởng, độ phức tạp, code C++/Python.
3. Server biên dịch và chấm trên test mẫu (AC / WA / TLE / RE / CE). Chạy được cả bài đọc/ghi file kiểu `BAI.INP`/`BAI.OUT`.
4. Nếu sai, gửi lỗi (input, output mong đợi, output của code) lại cho model sửa, tối đa 3 lần.

**🌐 Build web**: model viết một file HTML hoàn chỉnh, hiện bản xem trước ngay bên phải.

**💬 Hỏi đáp**: giải thích thuật toán, debug, trả lời câu hỏi lập trình.

## Cài đặt & chạy

Cần: macOS hoặc Linux, Python 3.10+, `g++` (macOS: `xcode-select --install`), [Ollama](https://ollama.com/download).

```sh
git clone <link-repo-này> && cd <tên-thư-mục>
./run.sh          # tự bật Ollama, tự tải model qwen3:4b nếu chưa có, rồi mở http://127.0.0.1:8000
```

Muốn dùng model khác: `ollama pull <tên-model>` rồi chọn trong giao diện.

## Chọn model (máy 8 GB RAM)

| Model | Dung lượng | Ghi chú |
|---|---|---|
| `qwen3.5:4b` | ~4 GB | Mạnh nhất trong nhóm nhỏ, có chế độ suy nghĩ |
| `qwen3:4b` | ~2.5 GB | Có chế độ suy nghĩ, nhẹ hơn |
| `qwen2.5-coder:3b` | ~1.9 GB | Chuyên code, nhanh |
| `qwen2.5-coder:7b` | ~4.7 GB | Code tốt hơn nhưng chậm, sát giới hạn RAM 8 GB |

Bật **Suy nghĩ** giúp giải bài khó đúng hơn nhưng chậm hơn nhiều. Model nhỏ làm tốt bài dễ và vừa; bài khó cỡ HSG quốc gia / VOI thường vượt sức của chúng.

## Cấu trúc

| File | Vai trò |
|---|---|
| `agent.py` | Prompt, quy trình viết code → chấm → tự sửa, gọi Ollama |
| `sandbox.py` | Biên dịch, chạy, chấm, stress test |
| `server.py` | FastAPI: chat (SSE), API chấm, xem trước web, lưu lịch sử vào `data/` |
| `static/` | Giao diện web |

## Lưu ý

- Code do AI viết chạy **trực tiếp trên máy bạn** (có giới hạn CPU, thời gian, kích thước file; không phải môi trường cách ly). Server chỉ nghe ở `127.0.0.1`.
- macOS không có `<bits/stdc++.h>`; `sandbox.py` tự tạo header thay thế trong `cpp_shim/`.
- Cấu hình tuỳ chọn trong `.env.example` (`OLLAMA_HOST`, `OLLAMA_NUM_CTX`).
