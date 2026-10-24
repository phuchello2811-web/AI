<p align="center"><img src="static/logo.svg" width="72" alt="CodeMaster"></p>

# CodeMaster — AI giải bài lập trình thi đấu và làm web

**Dùng ngay: https://phuchello2811-web.github.io/AI/** — mở link là dùng, không cần cài, không cần tài khoản, miễn phí.

- **Dùng ngay, không phải chờ tải:** mặc định dùng model mã nguồn mở **GPT-OSS 20B** (OpenAI) chạy miễn phí trên máy chủ của [Pollinations.ai](https://pollinations.ai). Đây là model suy luận, mạnh ở toán và lập trình thi đấu; ở mức "Tối đa" nó suy luận sâu hơn cho bài khó.
- **Gói miễn phí trả lời tối đa 1 lần mỗi 30 giây** cho mỗi người dùng. CodeMaster gộp các bước để mỗi bài chỉ cần 2–3 lần gọi, tự xếp hàng và tự thử lại. Ai có khoá Pollinations riêng có thể nhập trong *Cài đặt* để bỏ thời gian chờ.
- **Không giới hạn, chạy cả khi mất mạng:** chọn model *trong trình duyệt* (Qwen3.5 2B/4B/9B, Qwen2.5 Coder 7B) chạy bằng GPU của máy bạn qua [WebLLM](https://github.com/mlc-ai/web-llm); lần đầu tải 2–6 GB. Khi máy chủ miễn phí không phản hồi, CodeMaster tự chuyển sang model này.
- **Chấm code ngay trong trình duyệt:** C/C++ biên dịch bằng [Clang WebAssembly](https://github.com/YoWASP/clang), Python chạy bằng [Pyodide](https://pyodide.org). Trình biên dịch được tải sẵn ngầm khi mở trang nên lúc chấm không phải chờ.
- Lịch sử trò chuyện lưu trong trình duyệt của bạn.

## Cách nó làm việc

**Giải bài tin** (VOI, IOI, Google Code Jam / Kick Start, Codeforces…)
1. Đọc đề và lấy các test ví dụ (bỏ test nào không có trong đề, để tránh test bịa).
2. **Phân tích đề**: định dạng (stdin, file `.INP/.OUT`, `Case #x:` của Code Jam, tương tác, cài hàm cho grader IOI), giới hạn thời gian, độ phức tạp mục tiêu suy ra từ giới hạn n, quan sát chính, trường hợp biên.
3. **Tra thư viện kiến thức** (68 chủ đề: DP và các tối ưu DP, đồ thị, luồng, cấu trúc dữ liệu kể cả persistent/treap/Li Chao, xâu kể cả suffix automaton, toán số học và tổ hợp nâng cao, hình học, chiến thuật IOI/Code Jam, và 9 chủ đề làm web) và đưa các mục liên quan vào prompt.
4. Model giải theo **quy trình tư duy cố định**: chốt độ phức tạp, thử tay, cân nhắc ít nhất hai hướng, tìm phản ví dụ cho tham lam, liệt kê trường hợp biên, trace code trên test mẫu.
5. Biên dịch và chấm trên test mẫu (AC / WA / TLE / RE / CE).
6. **Stress test** (mức Tối đa): AI viết lời giải trâu và bộ sinh test nhỏ, rồi so sánh 150 test ngẫu nhiên, bắt được lỗi mà test mẫu bỏ sót.
7. Sai thì gửi lỗi về cho model tự sửa; hết lượt sửa thì yêu cầu **nghĩ lại từ đầu với hướng khác** (mức Tối đa).

| Mức suy nghĩ | Gồm |
|---|---|
| Nhanh | Tra kiến thức + giải + chấm mẫu, sửa 2 lần |
| Kỹ (mặc định) | + phân tích đề, sửa 3 lần |
| Tối đa | + stress test với lời giải trâu, + nghĩ lại từ đầu khi bế tắc |

Tab **Thư viện** trong giao diện cho xem và tìm toàn bộ kiến thức này.

**Làm web**: AI viết một trang HTML hoàn chỉnh theo hệ thống thiết kế (màu, chữ, khoảng cách, responsive, truy cập được), chạy thử trang trong khung ẩn để bắt lỗi JavaScript và tự sửa, rồi hiện bản xem trước bên phải.

**Hỏi đáp**: giải thích thuật toán, debug, trả lời câu hỏi lập trình.

## Chạy bằng Ollama (tuỳ chọn)

Không bắt buộc. Dùng khi muốn chạy model qua Ollama thay vì trong trình duyệt (ví dụ máy không có WebGPU, hoặc muốn dùng model Ollama khác). Khi server này đang chạy, giao diện tự dùng nó.

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
3. Bấm **Go Live** ở thanh trạng thái. Trang mở ở `http://127.0.0.1:5500` và dùng server nếu nó đang chạy; nếu không, trang tự chạy toàn bộ trong trình duyệt như bản trên GitHub Pages (không cần cài gì).

`.vscode/settings.json` cho Live Server bỏ qua `data/`, `workspace/` và file `.py`, để trang không tự tải lại khi server ghi lịch sử giữa lúc AI đang trả lời.

## Chọn model Ollama (máy 8 GB RAM)

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
| `knowledge.py` | Tra cứu thư viện thuật toán (IOI / Code Jam…) theo đề |
| `sandbox.py` | Biên dịch, chạy, chấm, stress test |
| `server.py` | FastAPI: chat (SSE), API chấm, xem trước web, lưu lịch sử vào `data/` |
| `index.html`, `static/` | Giao diện web (mở qua server, Go Live hoặc GitHub Pages) |
| `static/browser/` | Bản chạy hoàn toàn trong trình duyệt: model (WebLLM), quy trình giải bài, trình chấm WebAssembly, lưu lịch sử (IndexedDB) |
| `static/prompts.json`, `static/knowledge.json` | Prompt và thư viện kiến thức, dùng chung cho cả hai bản |
| `.vscode/` | Cấu hình Live Server và task tự bật server |

## Lưu ý

- Bản trong trình duyệt chạy code trong WebAssembly, cách ly sẵn. Với bản Ollama, code do AI viết chạy **trực tiếp trên máy bạn** (có giới hạn CPU, thời gian, kích thước file; không phải môi trường cách ly). Server chỉ nghe ở `127.0.0.1`.
- macOS không có `<bits/stdc++.h>`; `sandbox.py` tự tạo header thay thế trong `cpp_shim/`.
- Cấu hình tuỳ chọn trong `.env` (`OLLAMA_HOST`, `OLLAMA_NUM_CTX`, `PORT`, `CORS_ORIGIN_REGEX`). Mức Tối đa dùng nhiều ngữ cảnh: nếu máy đủ RAM, đặt `OLLAMA_NUM_CTX=12288` hoặc cao hơn.
- API chỉ nhận yêu cầu từ trang của chính server và từ Live Server (`127.0.0.1`/`localhost`, cổng 5500–5599).
- Cần Python 3.10+. macOS chỉ có sẵn 3.9; `run.sh` tự dùng bản mới hơn nếu có (`brew install python`).
