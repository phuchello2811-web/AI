<p align="center"><img src="static/logo.svg" width="72" alt="CodeMaster"></p>

# CodeMaster — AI giải bài lập trình thi đấu và làm web

**Dùng ngay: https://phuchello2811-web.github.io/AI/** — mở link là dùng, không cần cài, không cần tài khoản, miễn phí.

- **Dùng ngay, không phải tải gì:** nhóm model miễn phí, không cần tài khoản. Chế độ *Tự động* gửi mỗi yêu cầu tới model mạnh nhất còn lượt, hoặc chọn đích danh trong menu model:
  - **MiniMax M2.7** (qua [LLM7.io](https://llm7.io)), mạnh nhất trong nhóm miễn phí;
  - **GPT-OSS 20B** của OpenAI (qua [Pollinations.ai](https://pollinations.ai) và LLM7), model suy luận;
  - **Nemotron 3 Nano 30B** (NVIDIA), **Codestral** và **Mistral Nemo** (Mistral);
  - **ch.at** (model nhỏ của OpenAI): trả lời trong vài giây, gần như không giới hạn lượt. Dùng cho các bước phụ (đọc đề, phân tích, sinh test) để dành lượt của model mạnh cho bước viết lời giải, và là lựa chọn đầu tiên ở mức *Nhanh*.
- **Model hàng đầu qua [Puter](https://puter.com)** (đăng nhập tài khoản Puter miễn phí, dùng theo hạn mức hằng tháng của chính bạn, trang web không tốn phí): Claude Opus 5.5, GPT-5.6 Sol, Claude Sonnet 5.5, GPT-5.6 Terra, **Qwen3.8 Max**, DeepSeek V4 Pro, Gemini 4 Argon, Grok 4.7, Gemini 3.8 Flash, Kimi K2.7 Code, GLM-5.3, MiniMax M3. Các bước phụ dùng Qwen3.8 Flash cho tiết kiệm hạn mức. Puter lỗi thì tự quay về nhóm miễn phí.
- **Phối hợp nhiều model:** khi một model sửa mãi không đúng, bước "nghĩ lại từ đầu" giao cho **một model khác** để có góc nhìn mới.
- **Giới hạn của các gói miễn phí** (đo thực tế): Pollinations trả lời 1 lần mỗi 30 giây và ~1.400 token mỗi lần; LLM7 có hạn mức token mỗi ngày cho từng model (MiniMax hết sau khoảng 2 câu trả lời dài). CodeMaster tự xếp hàng, tự đổi model khi một model hết lượt (menu model hiện trạng thái "sẵn sàng / chờ / hết lượt đến…"), và tự **viết tiếp nhiều lượt** khi câu trả lời bị cắt. Có khoá riêng (Pollinations, LLM7) thì nhập trong *Cài đặt* để bỏ giới hạn.
- **Không giới hạn, chạy cả khi mất mạng:** chọn model *trong trình duyệt* (Qwen3.5 2B/4B/9B, Qwen2.5 Coder 7B) chạy bằng GPU của máy bạn qua [WebLLM](https://github.com/mlc-ai/web-llm); lần đầu tải 2–6 GB. Chỉ dùng khi chính bạn chọn, hoặc khi mọi máy chủ miễn phí đều không phản hồi.
- **Chấm code ngay trong trình duyệt:** C/C++ biên dịch bằng [Clang WebAssembly](https://github.com/YoWASP/clang), Python chạy bằng [Pyodide](https://pyodide.org); được tải sẵn ngầm khi mở trang.
- **Ghi nhớ bài đã giải:** mỗi bài AI giải đúng và đã kiểm chứng được lưu (ý tưởng chính) trong trình duyệt của bạn; gặp bài tương tự, AI được nhắc lại kinh nghiệm đó.
- Giao diện sáng/tối, thanh chọn chế độ và mức suy nghĩ, công thức toán (KaTeX), nút sao chép/hỏi lại/tải code, danh sách trò chuyện theo ngày và tìm kiếm, phím tắt (Ctrl/Cmd+K: trò chuyện mới, /: gõ); cài được như ứng dụng (PWA), có ảnh xem trước khi chia sẻ link.

> Về "huấn luyện model": huấn luyện hay tinh chỉnh một model ngôn ngữ cần cụm GPU chạy nhiều ngày, chi phí từ hàng nghìn đô trở lên, không làm được trong dự án này. CodeMaster dùng các model mã nguồn mở đã được huấn luyện sẵn ở mức cao nhất hiện có miễn phí, và tăng độ chính xác bằng quy trình: phân tích, tra kiến thức, chấm, stress test, kiểm tra tốc độ, tự sửa, ghi nhớ.

## Cách nó làm việc

**Giải bài tin** (VOI, IOI, Google Code Jam / Kick Start, Codeforces…)
1. Đọc đề và lấy các test ví dụ (bỏ test nào không có trong đề, để tránh test bịa).
2. **Phân tích đề**: định dạng (stdin, file `.INP/.OUT`, `Case #x:` của Code Jam, tương tác, cài hàm cho grader IOI), giới hạn thời gian, độ phức tạp mục tiêu suy ra từ giới hạn n, quan sát chính, trường hợp biên.
3. **Tra thư viện kiến thức** (142 bài học: DP và các tối ưu DP, slope trick, CDQ, đồ thị, luồng, cây Kruskal, liên thông động, cấu trúc dữ liệu kể cả persistent/treap/Li Chao, xâu kể cả suffix automaton và cây palindrome, toán (Gauss, cơ sở XOR, Möbius, Miller–Rabin), tổ hợp, hình học, chiến thuật IOI/Code Jam, code mẫu đã kiểm chứng cho số lớn, NTT, Dinic, cặp ghép, SCC, bao lồi, mảng hậu tố, Manacher…, mẹo C++/Python/JavaScript, SQL, Git, code sạch, kiểm thử, gỡ lỗi, cùng 39 bài làm web) và **các bài tương tự đã giải trước đây**, rồi đưa vào prompt.
4. Model giải theo **quy trình tư duy cố định**: chốt độ phức tạp, thử tay, cân nhắc ít nhất hai hướng, tìm phản ví dụ cho tham lam, liệt kê trường hợp biên, trace code trên test mẫu.
5. Biên dịch và chấm trên test mẫu (AC / WA / TLE / RE / CE).
6. **Stress test** (mức Tối đa): AI viết lời giải trâu và bộ sinh test nhỏ, rồi so sánh 150 test ngẫu nhiên, bắt được lỗi mà test mẫu bỏ sót.
7. **Kiểm tra tốc độ** (mức Tối đa): AI viết bộ sinh test lớn nhất theo giới hạn đề (trường hợp xấu nhất); lời giải phải chạy kịp thời gian, bắt được các lời giải đúng nhưng chậm (TLE).
8. Sai thì gửi lỗi về cho model tự sửa; hết lượt sửa thì yêu cầu **nghĩ lại từ đầu với hướng khác** (mức Tối đa).

| Mức suy nghĩ | Gồm |
|---|---|
| Nhanh | Tra kiến thức + giải + chấm mẫu, sửa 2 lần |
| Kỹ (mặc định) | + phân tích đề, sửa 3 lần |
| Tối đa | + suy luận sâu nhất, stress test, kiểm tra tốc độ trên test lớn nhất, nghĩ lại từ đầu khi bế tắc |

Tab **Thư viện** trong giao diện cho xem và tìm toàn bộ kiến thức này.

**Làm web**: AI lên kế hoạch (mục đích, các phần, bố cục điện thoại/máy tính, màu, tương tác), viết một trang HTML hoàn chỉnh theo hệ thống thiết kế, chạy thử trong khung ẩn để bắt lỗi JavaScript và tự sửa; ở mức Tối đa còn **tự đánh giá lại** theo yêu cầu (tính năng thiếu, giao diện điện thoại, nội dung) và cải tiến, nếu bản cải tiến lỗi thì giữ bản cũ.

**Hỏi đáp**: quy trình suy nghĩ riêng — với lỗi code thì tái hiện trên input cụ thể, tìm đúng dòng và nguyên nhân gốc; với thuật toán thì trực giác bằng ví dụ nhỏ, ý tưởng chính xác, chứng minh, độ phức tạp, bẫy thường gặp, gợi ý bài luyện tập. Chương trình hoàn chỉnh trong câu trả lời được **tự biên dịch thử**; lỗi biên dịch thì AI tự sửa.

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
