# CodeMaster — AI giải bài tin & build web, chạy trên máy bạn

Bộ não là một model mã nguồn mở chạy **offline** qua [Ollama](https://ollama.com), không gọi API của ai, không tốn phí.

## Cách nó làm việc

**🏆 Giải bài tin** (VOI, IOI, Google Code Jam / Kick Start…)
1. Đọc đề và lấy các test ví dụ (bỏ test nào không có trong đề, để tránh test bịa).
2. **Phân tích đề**: định dạng (stdin, file `.INP/.OUT`, `Case #x:` của Code Jam, tương tác, cài hàm cho grader IOI), giới hạn thời gian, độ phức tạp mục tiêu suy ra từ giới hạn n, quan sát chính, trường hợp biên.
3. **Tra thư viện thuật toán** (`knowledge.py`, 45 chủ đề: DP và các tối ưu DP, đồ thị, cấu trúc dữ liệu, xâu, toán, hình học, chiến thuật IOI/Code Jam…) và đưa các mục liên quan vào prompt.
4. Model giải theo **quy trình tư duy cố định**: chốt độ phức tạp, thử tay, cân nhắc ít nhất hai hướng, tìm phản ví dụ cho tham lam, liệt kê trường hợp biên, trace code trên test mẫu.
5. Server biên dịch và chấm trên test mẫu (AC / WA / TLE / RE / CE).
6. **Stress test** (mức Tối đa): AI viết lời giải trâu và bộ sinh test nhỏ, server so sánh 150 test ngẫu nhiên, bắt được lỗi mà test mẫu bỏ sót.
7. Sai thì gửi lỗi về cho model tự sửa; hết lượt sửa thì yêu cầu **nghĩ lại từ đầu với hướng khác** (mức Tối đa).

| Mức suy nghĩ | Gồm |
|---|---|
| ⚡ Nhanh | Tra kiến thức + giải + chấm mẫu, sửa 2 lần |
| 🧭 Kỹ (mặc định) | + phân tích đề, sửa 3 lần |
| 🧠 Tối đa | + stress test với lời giải trâu, + nghĩ lại từ đầu khi bế tắc |

Tab **📚 Thư viện** trong giao diện cho xem và tìm toàn bộ kiến thức này.

**🌐 Build web**: model viết một file HTML hoàn chỉnh, hiện bản xem trước ngay bên phải.

**💬 Hỏi đáp**: giải thích thuật toán, debug, trả lời câu hỏi lập trình.

## Cài đặt & chạy

Miễn phí, **không giới hạn số tin nhắn**, không cần tài khoản hay API key: model chạy ngay trên máy bạn.

**Cần có**
- [Ollama](https://ollama.com/download) (chạy model AI mã nguồn mở)
- Python 3.10+ ([python.org](https://www.python.org/downloads/); macOS: `brew install python`)
- Trình biên dịch C++ để chấm code: macOS `xcode-select --install` · Ubuntu `sudo apt install g++` · Windows `winget install BrechtSanders.WinLibs.POSIX.UCRT`
- Máy từ 8 GB RAM

**macOS / Linux**
```sh
git clone https://github.com/phuchello2811-web/AI.git
cd AI
./run.sh
```

**Windows**: tải về (Code → Download ZIP hoặc `git clone`), rồi bấm đúp `run.bat`.

Lần đầu chạy, script tự bật Ollama, tự tải model `qwen3:4b` (~2.5 GB) và cài thư viện. Sau đó mở http://127.0.0.1:8000.

Muốn dùng model khác: `ollama pull <tên-model>` rồi chọn trong giao diện.

## Chạy bằng nút Go Live trong VS Code

1. Mở thư mục này trong VS Code, cài extension **Live Server** (VS Code sẽ gợi ý).
2. Lần đầu mở, VS Code hỏi có cho phép task tự chạy không: chọn **Allow**. Từ đó mỗi lần mở thư mục, task *CodeMaster: server* tự bật Ollama và server (cổng 8000). Nếu không thấy hỏi: **Terminal → Run Task → CodeMaster: server**.
3. Bấm **Go Live** ở thanh trạng thái. Trang mở ở `http://127.0.0.1:5500` và tự kết nối server; nếu server chưa lên, trang hiện thông báo chờ và tự kết nối khi server sẵn sàng.

`.vscode/settings.json` cho Live Server bỏ qua `data/`, `workspace/` và file `.py`, để trang không tự tải lại khi server ghi lịch sử giữa lúc AI đang trả lời.

## Chọn model (máy 8 GB RAM)

| Model | Dung lượng | Ghi chú |
|---|---|---|
| `qwen3.5:4b` | ~4 GB | Mạnh nhất trong nhóm nhỏ, có chế độ suy nghĩ |
| `qwen3:4b` | ~2.5 GB | Có chế độ suy nghĩ, nhẹ hơn |
| `qwen2.5-coder:3b` | ~1.9 GB | Chuyên code, nhanh |
| `qwen2.5-coder:7b` | ~4.7 GB | Code tốt hơn nhưng chậm, sát giới hạn RAM 8 GB |

Bật **Suy nghĩ** giúp giải bài khó đúng hơn nhưng chậm hơn nhiều. Quy trình trên (phân tích, tra kiến thức, stress test, tự sửa) giúp model nhỏ đúng hơn hẳn so với hỏi thẳng, nhưng không thay đổi được "trí tuệ" của model: bài khó cỡ VOI / IOI vẫn thường vượt sức model 4B. Muốn mạnh hơn nữa, dùng model lớn hơn nếu máy đủ RAM.

## Cấu trúc

| File | Vai trò |
|---|---|
| `agent.py` | Prompt, quy trình phân tích → giải → chấm → stress test → tự sửa, gọi Ollama |
| `knowledge.py` | Thư viện thuật toán và quy tắc IOI / Code Jam, cách tra cứu theo đề |
| `sandbox.py` | Biên dịch, chạy, chấm, stress test |
| `server.py` | FastAPI: chat (SSE), API chấm, xem trước web, lưu lịch sử vào `data/` |
| `index.html`, `static/` | Giao diện web (mở qua server hoặc Go Live) |
| `.vscode/` | Cấu hình Live Server và task tự bật server |

## Lưu ý

- Code do AI viết chạy **trực tiếp trên máy bạn** (có giới hạn CPU, thời gian, kích thước file; không phải môi trường cách ly). Server chỉ nghe ở `127.0.0.1`.
- macOS không có `<bits/stdc++.h>`; `sandbox.py` tự tạo header thay thế trong `cpp_shim/`.
- Cấu hình tuỳ chọn trong `.env` (`OLLAMA_HOST`, `OLLAMA_NUM_CTX`, `PORT`, `CORS_ORIGIN_REGEX`). Mức Tối đa dùng nhiều ngữ cảnh: nếu máy đủ RAM, đặt `OLLAMA_NUM_CTX=12288` hoặc cao hơn.
- API chỉ nhận yêu cầu từ trang của chính server và từ Live Server (`127.0.0.1`/`localhost`, cổng 5500–5599).
- Cần Python 3.10+. macOS chỉ có sẵn 3.9; `run.sh` tự dùng bản mới hơn nếu có (`brew install python`).
