"""Competitive-programming knowledge base the agent retrieves from before solving.

A small local model cannot be retrained here, so instead the relevant techniques,
templates and contest rules (IOI, Google Code Jam / Kick Start, VOI) are looked up
for each problem and placed in the prompt. Entries are short on purpose: a few of
them must fit into an 8K-token context next to the problem and the reply.
"""

import re
import unicodedata

# Each entry: id, title, keys (lowercase, matched without Vietnamese diacritics), body (markdown).
ENTRIES = [
    # ---------- contest formats ----------
    {"id": "ioi_format", "title": "IOI: subtask, chấm điểm từng phần, grader",
     "keys": ["ioi", "subtask", "sub-task", "grader", "implement", "function", "ham", "goi ham", "partial", "diem"],
     "body": """- Đề IOI chia **subtask**; mỗi subtask được điểm khi qua hết test của nó. Nếu chưa ra lời giải đầy đủ, viết lời giải cho subtask nhỏ trước (brute force, n nhỏ, trường hợp đặc biệt như cây là đường thẳng, giá trị 0/1), rồi nâng dần.
- Thường phải **cài đặt hàm** theo chữ ký cho sẵn (không tự viết `main`), grader gọi hàm. Giữ đúng tên, kiểu tham số (`std::vector<int>`, `long long`), không đọc/ghi stdin trong hàm.
- Để thử trên máy, viết thêm `main()` mô phỏng *sample grader* (đọc đúng định dạng input của grader mẫu) và ghi chú rõ phải xoá `main` khi nộp.
- Bài *communication* / *output-only* / *interactive* có giới hạn số lần gọi hàm: đếm số truy vấn và tối ưu theo giới hạn đó."""},
    {"id": "gcj_format", "title": "Google Code Jam / Kick Start: định dạng Case #x",
     "keys": ["code jam", "codejam", "kick start", "kickstart", "case #", "test set", "visible", "hidden", "gcj", "hash code"],
     "body": """- Dòng đầu là **T** số test; mỗi test in đúng `Case #x: y` (x đánh số từ 1, có dấu cách sau dấu hai chấm). Sai chữ hoa/thường hoặc thiếu dấu cách là WA.
- Có *Test set 1* (nhỏ, thường brute force được) và *Test set 2/3* (lớn). Tính độ phức tạp theo **tổng** trên T test.
- Reset toàn bộ mảng/biến toàn cục giữa các test. Đáp án không tồn tại thường in `IMPOSSIBLE`.
- Bài interactive: đọc phản hồi của judge sau mỗi lần in, **flush** (`cout << endl` hoặc `fflush(stdout)`), dừng ngay khi đọc được `-1`.
```cpp
int T; cin >> T;
for (int tc = 1; tc <= T; ++tc) { /* giải */ cout << "Case #" << tc << ": " << ans << "\\n"; }
```"""},
    {"id": "interactive", "title": "Bài tương tác (interactive)",
     "keys": ["interactive", "tuong tac", "flush", "interactor", "guess", "doan so", "so lan hoi"],
     "body": """- In truy vấn rồi **flush** ngay: `cout << "? " << x << endl;` (endl có flush) hoặc `fflush(stdout)` với printf.
- Không dùng `cin.tie(nullptr)` nếu xen kẽ đọc/ghi mà không tự flush.
- Đếm số truy vấn so với giới hạn: thường là chia đôi (log2 n), chia ba, hoặc ngẫu nhiên hoá.
- Đọc `-1` từ judge nghĩa là sai: thoát ngay để nhận WA thay vì TLE."""},
    {"id": "file_io", "title": "VOI / HSG: đọc ghi file .INP/.OUT",
     "keys": [".inp", ".out", "voi", "hsg", "hoc sinh gioi", "freopen", "tep", "file"],
     "body": """```cpp
int main() {
    ios::sync_with_stdio(false); cin.tie(nullptr);
    freopen("BAI.INP", "r", stdin);
    freopen("BAI.OUT", "w", stdout);
}
```
- Tên file đúng như đề (thường viết hoa). Nhiều đề chấm theo subtask giống IOI: luôn đảm bảo ít nhất qua subtask nhỏ."""},

    # ---------- reasoning toolkit ----------
    {"id": "complexity", "title": "Chọn độ phức tạp theo giới hạn",
     "keys": ["gioi han", "constraint", "do phuc tap", "complexity", "time limit"],
     "body": """Khoảng 10^8 phép tính đơn giản/giây (C++).
| n tối đa | Độ phức tạp chạy kịp |
|---|---|
| ≤ 10–11 | O(n!), thử hoán vị |
| ≤ 20–25 | O(2^n · n), bitmask |
| ≤ 40 | meet in the middle O(2^(n/2)) |
| ≤ 500 | O(n^3) |
| ≤ 5000 | O(n^2) |
| ≤ 2·10^5–10^6 | O(n log n), O(n √n) nếu ≤ 10^5 |
| ≤ 10^7–10^8 | O(n), sàng tuyến tính |
| ≥ 10^9 | O(√n), O(log n), công thức, mũ hoá ma trận |"""},
    {"id": "pitfalls", "title": "Lỗi hay gặp khiến WA/RE/TLE",
     "keys": ["wa", "sai", "tran so", "overflow", "long long", "re", "tle", "loi"],
     "body": """- **Tràn số**: tích hai số 10^9 cần `long long`; tổng 2·10^5 số 10^9 cần `long long`; vượt 9·10^18 thì `__int128` hoặc mod.
- `(a - b) % MOD` có thể âm: dùng `((a - b) % MOD + MOD) % MOD`.
- Mảng toàn cục kích thước `N + 5`; đệ quy sâu 10^6 dễ tràn stack, chuyển sang vòng lặp/BFS.
- Nhiều test: reset mảng (chỉ phần đã dùng, không `memset` cả mảng 10^6 cho mỗi test).
- `endl` chậm khi in nhiều dòng: dùng `"\\n"`. Đọc nhanh `ios::sync_with_stdio(false); cin.tie(nullptr);`.
- So sánh số thực dùng epsilon; in số thực `fixed << setprecision(k)`.
- Kiểm tra n = 1, mọi phần tử bằng nhau, số âm, đáp án 0, đồ thị không liên thông."""},
    {"id": "greedy", "title": "Tham lam & chứng minh đổi chỗ",
     "keys": ["tham lam", "greedy", "lon nhat", "nho nhat", "toi uu", "sap xep", "lich", "schedule", "deadline", "interval"],
     "body": """- Sắp xếp theo khoá phù hợp rồi chọn dần. Chứng minh bằng **exchange argument**: đổi chỗ hai phần tử kề nhau sai thứ tự không làm kết quả tốt hơn.
- Mẫu kinh điển: chọn nhiều đoạn không giao nhau (sort theo điểm kết thúc); xếp lịch có deadline (sort deadline + heap); so sánh a+b vs b+a khi ghép chuỗi.
- **Luôn thử tìm phản ví dụ nhỏ** cho tham lam trước khi tin nó. Nếu tìm được, chuyển sang DP."""},
    {"id": "binary_search", "title": "Chia nhị phân đáp án",
     "keys": ["chat nhi phan", "chia nhi phan", "binary search", "lon nhat sao cho", "nho nhat sao cho", "toi thieu hoa gia tri lon nhat", "minimize maximum", "maximize minimum", "it nhat", "nhieu nhat"],
     "body": """Dùng khi có hàm kiểm tra `ok(x)` **đơn điệu** (đúng từ một ngưỡng trở đi). Thường gặp: "tối thiểu hoá giá trị lớn nhất", "lớn nhất sao cho".
```cpp
long long lo = 0, hi = 2e18; // ok(hi) đúng
while (lo < hi) { long long mid = lo + (hi - lo) / 2; if (ok(mid)) hi = mid; else lo = mid + 1; }
```
Số thực: lặp cố định 100 lần. Kết hợp `lower_bound`/`upper_bound` trên mảng đã sort."""},
    {"id": "two_pointers", "title": "Hai con trỏ / cửa sổ trượt",
     "keys": ["hai con tro", "two pointers", "doan con", "subarray", "lien tiep", "cua so", "window", "tong khong vuot qua", "do dai lon nhat"],
     "body": """Khi đoạn [l, r] hợp lệ kéo theo mọi đoạn con của nó hợp lệ: tăng r, khi vi phạm thì tăng l. O(n).
```cpp
for (int l = 0, r = 0; r < n; ++r) { add(a[r]); while (bad()) remove(a[l++]); best = max(best, r - l + 1); }
```"""},
    {"id": "prefix_sums", "title": "Tổng tiền tố, mảng hiệu, tổng 2D",
     "keys": ["tong tien to", "prefix sum", "tong doan", "range sum", "mang hieu", "difference array", "cong vao doan", "kadane", "tong lon nhat", "doan con lien tiep"],
     "body": """- `p[i] = p[i-1] + a[i]`, tổng đoạn `[l, r] = p[r] - p[l-1]`. Đếm đoạn có tổng = k: map đếm `p[j]`.
- Mảng hiệu: cộng v vào `[l, r]`: `d[l] += v, d[r+1] -= v`, sau đó cộng dồn.
- 2D: `S[i][j] = a[i][j] + S[i-1][j] + S[i][j-1] - S[i-1][j-1]`.
- Kadane cho đoạn con tổng lớn nhất: `cur = max(a[i], cur + a[i])`."""},
    {"id": "meet_middle", "title": "Meet in the middle",
     "keys": ["meet in the middle", "chia doi tap", "n <= 40", "40"],
     "body": "Chia tập thành hai nửa ~n/2, liệt kê 2^(n/2) tổng mỗi nửa, sort một nửa rồi chặt nhị phân / hai con trỏ để ghép. O(2^(n/2) · n)."},

    # ---------- dynamic programming ----------
    {"id": "dp_basics", "title": "Quy hoạch động: cách thiết kế",
     "keys": ["quy hoach dong", "dp", "dynamic programming", "so cach", "dem so cach", "number of ways", "toi uu", "cai tui", "knapsack", "day con"],
     "body": """1. Trạng thái: những gì cần nhớ để quyết định phần còn lại (vị trí, dung lượng còn lại, phần tử cuối...).
2. Chuyển trạng thái + trường hợp cơ sở; thứ tự tính sao cho phụ thuộc đã có.
3. Độ phức tạp = số trạng thái × chi phí chuyển; phải hợp giới hạn.
- Cái túi 0/1: `for item: for w = W..wi: dp[w] = max(dp[w], dp[w-wi] + vi)` (duyệt ngược).
- Đếm số cách: cộng mod; tối ưu: max/min, khởi tạo ±INF.
- LCS / edit distance: `dp[i][j]` trên hai tiền tố."""},
    {"id": "lis", "title": "Dãy con tăng dài nhất O(n log n)",
     "keys": ["day con tang", "lis", "increasing subsequence", "tang dan dai nhat", "khong giam"],
     "body": """```cpp
vector<int> d; // d[k] = phần tử cuối nhỏ nhất của dãy tăng độ dài k+1
for (int x : a) { auto it = lower_bound(d.begin(), d.end(), x); if (it == d.end()) d.push_back(x); else *it = x; }
// không giảm: dùng upper_bound
```"""},
    {"id": "dp_bitmask", "title": "DP bitmask (n ≤ 20)",
     "keys": ["bitmask", "bit mask", "tap con", "subset", "tsp", "nguoi du lich", "hamilton", "n <= 20", "phan cong"],
     "body": """- `dp[mask][v]`: đã thăm tập `mask`, đang ở `v` (TSP/Hamilton) — O(2^n · n^2).
- Duyệt tập con của mask: `for (int s = mask; s; s = (s - 1) & mask)` — tổng O(3^n).
- SOS DP (tổng trên mọi tập con): `for i: for mask: if (mask >> i & 1) f[mask] += f[mask ^ (1 << i)]`."""},
    {"id": "dp_interval", "title": "DP đoạn (interval DP)",
     "keys": ["dp doan", "interval dp", "gop", "merge", "nhan ma tran", "matrix chain", "palindrome", "xau doi xung", "cat"],
     "body": "`dp[l][r]` = kết quả cho đoạn [l, r], tính theo độ dài tăng dần: `dp[l][r] = min(dp[l][k] + dp[k+1][r] + cost(l, r))`. O(n^3); với cost thoả bất đẳng thức tứ giác dùng Knuth giảm còn O(n^2)."},
    {"id": "dp_digit", "title": "DP chữ số (digit DP)",
     "keys": ["chu so", "digit", "tu l den r", "trong doan [l, r]", "dem so", "count numbers", "10^18"],
     "body": """Đếm số trong [0, X] thoả tính chất: duyệt chữ số từ trái, trạng thái `(pos, tight, state...)`. Kết quả [L, R] = f(R) - f(L-1).
```cpp
long long go(int pos, bool tight, int st) { if (pos == len) return good(st);
  long long &r = memo[pos][st]; if (!tight && r != -1) return r; long long res = 0;
  for (int d = 0; d <= (tight ? dig[pos] : 9); ++d) res += go(pos + 1, tight && d == dig[pos], nxt(st, d));
  if (!tight) r = res; return res; }
```"""},
    {"id": "dp_tree", "title": "DP trên cây & rerooting",
     "keys": ["dp tren cay", "tree dp", "cay", "subtree", "cay con", "reroot", "moi dinh lam goc", "tap doc lap", "independent set"],
     "body": """- DFS, tính `dp[u]` từ các con. Ví dụ tập độc lập lớn nhất: `dp[u][0] = Σ max(dp[c][0], dp[c][1])`, `dp[u][1] = 1 + Σ dp[c][0]`.
- **Rerooting** (đáp án cho mọi gốc): DFS1 tính `down[u]`, DFS2 truyền `up[u]` từ cha xuống, dùng tiền tố/hậu tố của các con để loại trừ một con. O(n).
- Cây sâu 2·10^5: tránh đệ quy hoặc thứ tự BFS ngược."""},
    {"id": "dp_optimization", "title": "Tối ưu DP: CHT, chia để trị, Knuth, Aliens",
     "keys": ["convex hull trick", "cht", "li chao", "chia de tri", "divide and conquer optimization", "knuth", "aliens", "wqs", "lagrange", "k doan", "chia thanh k"],
     "body": """- **CHT / Li Chao**: `dp[i] = min_j (m_j · x_i + b_j)` → tập đường thẳng, truy vấn O(log n).
- **Chia để trị**: `dp[k][i] = min_j dp[k-1][j] + C(j, i)` với opt(i) đơn điệu → O(k · n log n).
- **Knuth**: opt[l][r-1] ≤ opt[l][r] ≤ opt[l+1][r] → O(n^2).
- **Aliens trick / WQS** (IOI 2016 Aliens): ràng buộc "đúng k nhóm" và đáp án lồi theo k → phạt λ cho mỗi nhóm, chặt nhị phân λ, bỏ chiều k."""},

    # ---------- graphs ----------
    {"id": "bfs_dfs", "title": "BFS, DFS, 0-1 BFS, đồ thị lưới",
     "keys": ["bfs", "dfs", "do thi", "graph", "luoi", "grid", "me cung", "maze", "duong di ngan nhat", "lien thong", "connected", "o vuong"],
     "body": """- BFS cho đường đi ngắn nhất trọng số bằng nhau; **0-1 BFS** (deque: cạnh 0 đẩy đầu, cạnh 1 đẩy cuối) khi trọng số 0/1.
- Lưới: `dx[] = {1,-1,0,0}, dy[] = {0,0,1,-1}`, kiểm tra biên, đánh dấu khi **đẩy vào** hàng đợi.
- BFS đa nguồn: đẩy mọi nguồn vào với khoảng cách 0."""},
    {"id": "dijkstra", "title": "Dijkstra, Bellman-Ford, Floyd",
     "keys": ["dijkstra", "duong di ngan nhat", "shortest path", "trong so", "weighted", "bellman", "floyd", "chu trinh am", "negative"],
     "body": """```cpp
vector<long long> d(n, INF); priority_queue<pair<long long,int>, vector<pair<long long,int>>, greater<>> pq;
d[s] = 0; pq.push({0, s});
while (!pq.empty()) { auto [du, u] = pq.top(); pq.pop(); if (du != d[u]) continue;
  for (auto [v, w] : g[u]) if (d[u] + w < d[v]) { d[v] = d[u] + w; pq.push({d[v], v}); } }
```
- Trọng số âm: Bellman-Ford O(nm), phát hiện chu trình âm ở lần lặp thứ n. Mọi cặp n ≤ 400: Floyd O(n^3).
- Đồ thị trạng thái: đỉnh = (vị trí, số lần đã dùng vé...)."""},
    {"id": "dsu", "title": "DSU (Disjoint Set Union) & Kruskal",
     "keys": ["dsu", "disjoint", "union find", "hop nhat", "cay khung", "mst", "spanning tree", "kruskal", "thanh phan lien thong"],
     "body": """```cpp
struct DSU { vector<int> p, sz; DSU(int n): p(n), sz(n, 1) { iota(p.begin(), p.end(), 0); }
  int find(int x) { while (x != p[x]) x = p[x] = p[p[x]]; return x; }
  bool unite(int a, int b) { a = find(a); b = find(b); if (a == b) return false;
    if (sz[a] < sz[b]) swap(a, b); p[b] = a; sz[a] += sz[b]; return true; } };
```
- Kruskal: sort cạnh tăng dần, `unite` thì lấy cạnh. Xử lý offline (thêm cạnh theo thời gian/ngưỡng) rất hay dùng.
- DSU rollback (không nén đường) + chia để trị theo thời gian cho truy vấn thêm/xoá cạnh offline."""},
    {"id": "toposort_scc", "title": "Topo sort, SCC (Tarjan/Kosaraju), 2-SAT",
     "keys": ["topo", "topological", "dag", "khong chu trinh", "scc", "thanh phan lien thong manh", "tarjan", "kosaraju", "2-sat", "2sat", "chu trinh"],
     "body": """- Topo (Kahn): đẩy đỉnh bậc vào 0; DP trên DAG theo thứ tự topo. Không đủ n đỉnh ⇒ có chu trình.
- SCC Tarjan O(n+m): `low[u] = min(low[u], tin[v])` với v trên stack; co SCC thành DAG.
- 2-SAT: mỗi mệnh đề (a ∨ b) thành cạnh ¬a→b, ¬b→a; vô nghiệm nếu x và ¬x cùng SCC; nghiệm: x = comp[x] < comp[¬x] theo thứ tự Tarjan."""},
    {"id": "bridges", "title": "Cầu, khớp, thành phần song liên thông",
     "keys": ["cau", "bridge", "khop", "articulation", "cut vertex", "song lien thong", "biconnected"],
     "body": "DFS với `tin[u]`, `low[u] = min(tin[u], tin[v] (cạnh ngược), low[con])`. Cạnh (u, v) là cầu nếu `low[v] > tin[u]`; u là khớp nếu `low[v] >= tin[u]` (gốc: ≥ 2 con). Bỏ qua cạnh cha theo **id cạnh** để xử lý cạnh song song."},
    {"id": "lca", "title": "LCA nhảy nhị phân, Euler tour",
     "keys": ["lca", "to tien chung", "ancestor", "khoang cach tren cay", "khoang cach giua hai dinh", "distance between", "binary lifting", "nhay nhi phan", "euler tour", "duong di tren cay"],
     "body": """```cpp
// up[k][v] = tổ tiên thứ 2^k của v; dep[v] = độ sâu
int lca(int a, int b) { if (dep[a] < dep[b]) swap(a, b);
  for (int k = LOG - 1; k >= 0; --k) if (dep[a] - (1 << k) >= dep[b]) a = up[k][a];
  if (a == b) return a;
  for (int k = LOG - 1; k >= 0; --k) if (up[k][a] != up[k][b]) a = up[k][a], b = up[k][b];
  return up[0][a]; }
```
- dist(u, v) = dep[u] + dep[v] - 2·dep[lca]. Euler tour `tin/tout` biến cây con thành đoạn liên tiếp → dùng Fenwick/segment tree."""},
    {"id": "hld_centroid", "title": "HLD, centroid decomposition, small-to-large",
     "keys": ["hld", "heavy light", "centroid", "phan ra trong tam", "small to large", "dsu on tree", "gop tap", "duong di tren cay", "dem cap dinh"],
     "body": """- **HLD**: truy vấn/cập nhật trên đường đi u-v bằng O(log n) đoạn liên tiếp × segment tree ⇒ O(log² n).
- **Centroid decomposition**: đếm cặp đỉnh có khoảng cách thoả điều kiện, O(n log n) tầng × xử lý mỗi tầng (IOI 2011 Race).
- **Small-to-large**: gộp set/map của con nhỏ vào con lớn, tổng O(n log² n)."""},
    {"id": "flow_matching", "title": "Luồng cực đại (Dinic), cặp ghép, min-cut",
     "keys": ["luong", "max flow", "flow", "dinic", "cap ghep", "matching", "bipartite", "hai phia", "min cut", "lat cat", "phan cong", "assignment", "hopcroft"],
     "body": """- Dinic O(V²E), rất nhanh trên đồ thị đơn vị; cặp ghép hai phía: Kuhn O(VE) hoặc Hopcroft-Karp O(E√V).
- Định lý König: cặp ghép cực đại = phủ đỉnh nhỏ nhất (đồ thị hai phía). Max flow = min cut.
- Chi phí nhỏ nhất: min-cost flow (SPFA/Dijkstra với thế vị). Giới hạn n ≤ vài trăm thường là dấu hiệu luồng."""},

    # ---------- data structures ----------
    {"id": "fenwick", "title": "Fenwick tree (BIT)",
     "keys": ["fenwick", "bit", "binary indexed", "nghich the", "inversion", "dem so nho hon", "cap nhat diem", "tong doan", "point update"],
     "body": """```cpp
struct BIT { int n; vector<long long> t; BIT(int n): n(n), t(n + 1) {}
  void add(int i, long long v) { for (; i <= n; i += i & -i) t[i] += v; }
  long long sum(int i) { long long s = 0; for (; i > 0; i -= i & -i) s += t[i]; return s; } };
```
Đếm nghịch thế: nén toạ độ, duyệt và đếm số phần tử lớn hơn đã gặp. O(n log n)."""},
    {"id": "segment_tree", "title": "Segment tree + lazy propagation",
     "keys": ["segment tree", "cay phan doan", "interval tree", "lazy", "cap nhat doan", "truy van doan", "range update", "range query", "min doan", "max doan"],
     "body": """```cpp
long long t[4 * N], lz[4 * N];
void push(int v, int l, int r) { if (!lz[v]) return; int m = (l + r) / 2;
  t[2*v] += lz[v] * (m - l + 1); lz[2*v] += lz[v]; t[2*v+1] += lz[v] * (r - m); lz[2*v+1] += lz[v]; lz[v] = 0; }
void upd(int v, int l, int r, int ql, int qr, long long x) { if (qr < l || r < ql) return;
  if (ql <= l && r <= qr) { t[v] += x * (r - l + 1); lz[v] += x; return; }
  push(v, l, r); int m = (l + r) / 2; upd(2*v, l, m, ql, qr, x); upd(2*v+1, m+1, r, ql, qr, x); t[v] = t[2*v] + t[2*v+1]; }
long long qry(int v, int l, int r, int ql, int qr) { if (qr < l || r < ql) return 0;
  if (ql <= l && r <= qr) return t[v]; push(v, l, r); int m = (l + r) / 2; return qry(2*v, l, m, ql, qr) + qry(2*v+1, m+1, r, ql, qr); }
```
- Nút lưu cấu trúc ghép được (max đoạn con, số đoạn...) cho bài phức tạp. Walk trên cây để tìm vị trí đầu tiên ≥ x trong O(log n).
- Persistent segment tree: truy vấn phần tử nhỏ thứ k trên đoạn."""},
    {"id": "sparse_table", "title": "Sparse table (RMQ O(1))",
     "keys": ["sparse table", "rmq", "min doan", "max doan", "khong cap nhat", "static", "gcd doan"],
     "body": "`st[k][i] = min(st[k-1][i], st[k-1][i + 2^(k-1)])`; truy vấn [l, r]: `k = __lg(r - l + 1)`, `min(st[k][l], st[k][r - 2^k + 1])`. Dùng cho thao tác lũy đẳng (min, max, gcd), mảng không đổi."},
    {"id": "monotonic", "title": "Stack đơn điệu, deque min cửa sổ",
     "keys": ["stack don dieu", "monotonic", "phan tu lon hon gan nhat", "next greater", "histogram", "hinh chu nhat lon nhat", "deque", "min cua so", "sliding window"],
     "body": """- Phần tử lớn hơn gần nhất bên phải: duyệt, pop khi `a[st.top()] < a[i]`. O(n). Hình chữ nhật lớn nhất trong histogram cũng dùng cách này.
- Min/max trên mọi cửa sổ độ dài k: deque giữ chỉ số với giá trị tăng dần, bỏ đầu khi ra khỏi cửa sổ.
- Tối ưu DP `dp[i] = min_{i-k ≤ j < i} dp[j] + c` bằng deque."""},
    {"id": "ordered_set", "title": "set/map, pb_ds ordered set, heap",
     "keys": ["set", "map", "multiset", "priority queue", "heap", "hang doi uu tien", "thu tu thu k", "k-th", "order statistic", "trung vi", "median"],
     "body": """```cpp
#include <ext/pb_ds/assoc_container.hpp>
using namespace __gnu_pbds;
template<class T> using oset = tree<T, null_type, less<T>, rb_tree_tag, tree_order_statistics_node_update>;
// s.find_by_order(k): phần tử thứ k (0-index); s.order_of_key(x): số phần tử < x
```
- Trung vị động: hai heap. Multiset xoá một bản: `s.erase(s.find(x))`."""},
    {"id": "sqrt_mo", "title": "Chia căn & thuật toán Mo",
     "keys": ["chia can", "sqrt", "mo's", "thuat toan mo", "offline", "so gia tri khac nhau", "distinct", "block"],
     "body": "Mo: sort truy vấn theo `(l / B, r)` với B ≈ √n, di chuyển hai đầu và cập nhật `add/remove` O(1) ⇒ O((n + q)√n). Chia khối √n cho cập nhật + truy vấn khi segment tree khó ghép thông tin."},
    {"id": "offline_tricks", "title": "Xử lý offline: sort truy vấn, chặt nhị phân song song",
     "keys": ["offline", "truy van", "queries", "parallel binary search", "chat nhi phan song song", "thoi diem dau tien", "sweep", "quet"],
     "body": """- Sort truy vấn cùng sự kiện (sweep line), trả lời theo thứ tự rồi in theo chỉ số gốc.
- **Chặt nhị phân song song**: mỗi truy vấn cần "thời điểm sớm nhất thoả", mô phỏng lại các cập nhật log(T) vòng cho mọi truy vấn cùng lúc.
- Nén toạ độ: `sort + unique + lower_bound`."""},

    # ---------- strings ----------
    {"id": "string_kmp_z", "title": "KMP (prefix function), Z-function",
     "keys": ["kmp", "prefix function", "z function", "z-function", "tim xau", "pattern", "xau con", "substring", "chu ky", "period", "xau"],
     "body": """```cpp
vector<int> pi(const string& s) { int n = s.size(); vector<int> p(n);
  for (int i = 1; i < n; ++i) { int j = p[i-1]; while (j && s[i] != s[j]) j = p[j-1]; if (s[i] == s[j]) ++j; p[i] = j; } return p; }
```
- Tìm P trong T: `pi(P + '#' + T)`, vị trí có giá trị = |P|. Chu kỳ nhỏ nhất: `n - pi[n-1]`."""},
    {"id": "hashing", "title": "Hash xâu",
     "keys": ["hash", "bam", "so sanh xau", "xau con giong nhau", "palindrome", "doi xung", "rolling"],
     "body": "Hash đa thức mod 2^61-1 (hoặc hai mod) với cơ số ngẫu nhiên: `h[i+1] = h[i]·B + s[i]`, `get(l, r) = h[r] - h[l]·B^(r-l)`. Kết hợp chặt nhị phân độ dài (xâu con chung dài nhất, palindrome dài nhất)."},
    {"id": "trie_aho", "title": "Trie, Aho-Corasick, XOR lớn nhất",
     "keys": ["trie", "aho", "corasick", "nhieu mau", "tien to", "prefix tree", "xor lon nhat", "max xor", "tu dien"],
     "body": "- Trie bit: XOR lớn nhất của x với phần tử trong tập: đi theo bit ngược từ bit cao.\n- Aho-Corasick: trie + liên kết hậu tố (BFS), đếm số lần xuất hiện của nhiều mẫu trong O(tổng độ dài)."},
    {"id": "suffix_manacher", "title": "Suffix array, Manacher",
     "keys": ["suffix array", "mang hau to", "lcp", "manacher", "palindrome dai nhat", "doi xung dai nhat", "so xau con khac nhau"],
     "body": "- Suffix array O(n log n) + LCP (Kasai): số xâu con khác nhau = Σ(n - sa[i]) - Σ lcp.\n- Manacher O(n): bán kính palindrome lẻ/chẵn tại mỗi tâm."},

    # ---------- math ----------
    {"id": "modular", "title": "Số học modulo, nghịch đảo, tổ hợp",
     "keys": ["modulo", "mod", "10^9+7", "1e9+7", "998244353", "to hop", "nck", "binomial", "giai thua", "nghich dao", "luy thua", "power", "chinh hop"],
     "body": """```cpp
const long long MOD = 1e9 + 7;
long long pw(long long a, long long e) { long long r = 1; a %= MOD; for (; e; e >>= 1, a = a * a % MOD) if (e & 1) r = r * a % MOD; return r; }
// fact[i], inv[i] = pw(fact[i], MOD - 2); C(n, k) = fact[n] * inv[k] % MOD * inv[n - k] % MOD
```
- Chia modulo = nhân nghịch đảo (MOD nguyên tố). Lucas khi n lớn hơn MOD nhỏ. Bao hàm loại trừ, chia kẹo Euler C(n + k - 1, k - 1)."""},
    {"id": "number_theory", "title": "Sàng nguyên tố, ước, GCD, CRT",
     "keys": ["nguyen to", "prime", "sang", "sieve", "uoc", "divisor", "gcd", "ucln", "bcnn", "lcm", "euclid", "crt", "trung hoa", "phi", "euler", "phan tich"],
     "body": """- Sàng Eratosthenes O(n log log n); sàng ước nhỏ nhất `spf` để phân tích nhanh mọi số ≤ 10^7.
- Phân tích n ≤ 10^12: thử ước đến √n. n ≤ 10^18: Miller-Rabin + Pollard rho.
- Euclid mở rộng giải ax + by = gcd; CRT ghép đồng dư. Số ước của n ≤ 10^9 tối đa 1344.
- Tổng `Σ n / i` theo khối: giá trị `n / i` có O(√n) giá trị khác nhau."""},
    {"id": "matrix_expo", "title": "Lũy thừa ma trận (truy hồi tuyến tính)",
     "keys": ["ma tran", "matrix", "fibonacci", "truy hoi", "recurrence", "10^18", "luy thua ma tran", "so buoc"],
     "body": "Truy hồi tuyến tính bậc k với n tới 10^18: dựng ma trận k×k, lũy thừa nhị phân O(k³ log n). Cũng dùng đếm đường đi độ dài n trong đồ thị nhỏ."},
    {"id": "fft", "title": "FFT / NTT nhân đa thức",
     "keys": ["fft", "ntt", "da thuc", "polynomial", "tich chap", "convolution", "nhan so lon"],
     "body": "Nhân hai đa thức bậc n trong O(n log n). NTT mod 998244353 (căn nguyên thuỷ 3) khi cần kết quả mod. Dùng cho đếm tổng cặp, so khớp xâu có ký tự đại diện."},
    {"id": "geometry", "title": "Hình học: tích có hướng, bao lồi",
     "keys": ["hinh hoc", "geometry", "diem", "toa do", "tich co huong", "cross", "bao loi", "convex hull", "da giac", "dien tich", "polygon", "giao nhau"],
     "body": """- `cross(a, b, c) = (b - a) × (c - a)`: > 0 rẽ trái. Dùng `long long`, tránh số thực khi được.
- Diện tích đa giác (shoelace) = |Σ x_i·y_{i+1} - x_{i+1}·y_i| / 2.
- Bao lồi monotone chain O(n log n): sort điểm, dựng nửa dưới và nửa trên."""},
    {"id": "game_theory", "title": "Lý thuyết trò chơi: Nim, Sprague-Grundy",
     "keys": ["tro choi", "game", "nim", "grundy", "sprague", "nguoi thang", "winner", "luot", "alice", "bob", "first player"],
     "body": "- Trạng thái thua nếu mọi nước đi tới trạng thái thắng. Nim: thắng ⇔ XOR các đống ≠ 0.\n- Tổng nhiều trò chơi độc lập: Grundy = mex của các trạng thái kế tiếp, XOR lại. Với giới hạn lớn, tính Grundy cho n nhỏ bằng brute force rồi tìm quy luật."},
    {"id": "constructive", "title": "Bài xây dựng (constructive) & quan sát",
     "keys": ["xay dung", "construct", "in ra mot", "bat ky", "any", "neu khong ton tai", "-1", "hoan vi", "permutation", "dieu kien can"],
     "body": "- Tìm **điều kiện cần** (chẵn lẻ, tổng, bất biến) rồi chứng minh nó cũng đủ bằng một cách xây dựng.\n- Thử tay n = 1..6, viết brute force in mọi đáp án nhỏ để thấy mẫu.\n- Bất biến / đơn biến: đại lượng không đổi (hoặc luôn giảm) qua mỗi thao tác."},
    {"id": "stress_testing", "title": "Stress test: brute force + sinh test",
     "keys": ["stress", "brute", "sinh test", "random", "ngau nhien", "doi chieu", "kiem tra"],
     "body": "Viết lời giải trâu (chắc chắn đúng, chậm) và chương trình sinh test nhỏ ngẫu nhiên; so sánh hàng trăm test. Test sai đầu tiên thường nhỏ, đủ để trace tay. CodeMaster tự làm việc này ở mức suy nghĩ **Tối đa**."},
]

BY_ID = {e["id"]: e for e in ENTRIES}
TOPIC_IDS = [e["id"] for e in ENTRIES]


def normalize(text: str) -> str:
    """Lowercase and strip Vietnamese diacritics so "Quy hoạch động" matches "quy hoach dong"."""
    text = text.lower().replace("đ", "d")
    text = "".join(c for c in unicodedata.normalize("NFD", text) if unicodedata.category(c) != "Mn")
    return re.sub(r"\s+", " ", text)


_NUM = r"(10\s*\^\s*\{?\d+\}?|\d+(?:[.,]\d+)?\s*(?:(?:[·*x×.]|\\cdot)\s*10\s*\^\s*\{?\d+\}?|e\d+)?)"
_BOUND_RE = re.compile(r"(?<![\w])([A-Za-z]\w{0,2}|\|[a-z]\w{0,2}\|)\s*(?:≤|<=|<|\\le)\s*" + _NUM)
SIZE_VARS = {"n", "m", "q", "k", "t", "|s|"}


def _number(text: str) -> float:
    text = text.replace(" ", "")
    m = re.fullmatch(r"10\^\{?(\d+)\}?", text)
    if m:
        return 10.0 ** int(m.group(1))
    m = re.fullmatch(r"(\d+(?:[.,]\d+)?)(?:(?:[·*x×.]|\\cdot)10\^\{?(\d+)\}?|e(\d+))?", text)
    if not m:
        return 0.0
    exp = m.group(2) or m.group(3)
    return float(m.group(1).replace(",", ".")) * (10.0 ** int(exp) if exp else 1.0)


def bounds(statement: str) -> tuple[float, float]:
    """(largest size bound like n ≤ 2·10^5, largest other bound like a_i ≤ 10^9) found in the statement."""
    size = value = 0.0
    for var, num in _BOUND_RE.findall(statement.replace(" ", " ")):
        x = _number(num)
        if var.lower() in SIZE_VARS:
            size = max(size, x)
        else:
            value = max(value, x)
    return size, value


def constraint_hint(statement: str) -> str:
    n, value = bounds(statement)
    if n <= 0:
        if value >= 1e9:
            return f"Giá trị tới {value:g} ⇒ không duyệt từng giá trị: cần O(√X), O(log X) hoặc công thức."
        return ""
    if n <= 11:
        target = "O(n!) hoặc vét cạn"
    elif n <= 25:
        target = "O(2^n · n) — bitmask"
    elif n <= 45:
        target = "O(2^(n/2)) — meet in the middle"
    elif n <= 500:
        target = "O(n^3)"
    elif n <= 5000:
        target = "O(n^2)"
    elif n <= 1e6:
        target = "O(n log n) hoặc O(n √n)"
    elif n <= 1e8:
        target = "O(n)"
    else:
        target = "O(√n), O(log n) hoặc công thức (không duyệt từng giá trị)"
    return f"Kích thước lớn nhất n ≈ {n:g} ⇒ độ phức tạp mục tiêu: {target}."


def _bound_topics(statement: str) -> list[str]:
    n, value = bounds(statement)
    if 0 < n <= 25:
        return ["dp_bitmask"]
    if 25 < n <= 45:
        return ["meet_middle"]
    if n >= 1e12 or (not n and value >= 1e12):
        return ["matrix_expo", "number_theory", "binary_search"]
    return []


def _key_re(key: str) -> re.Pattern:
    return re.compile(r"(?<![a-z0-9])" + re.escape(normalize(key)) + r"(?![a-z0-9])")


_KEY_RES = {e["id"]: [(len(k.split()), _key_re(k)) for k in e["keys"]] for e in ENTRIES}


def retrieve(text: str, topics: list[str] | None = None, k: int = 3, min_score: float = 2.0) -> list[dict]:
    """Rank entries by keyword hits in `text`; ids in `topics` (chosen by the model) get a large bonus."""
    norm = normalize(text)
    chosen = set(topics or []) | set(_bound_topics(text))
    scored = []
    for e in ENTRIES:
        score = sum(weight for weight, rx in _KEY_RES[e["id"]] if rx.search(norm))
        if e["id"] in chosen:
            score += 6
        if score >= min_score:
            scored.append((score, e))
    scored.sort(key=lambda s: -s[0])
    return [e for _, e in scored[:k]]


def as_prompt(entries: list[dict]) -> str:
    if not entries:
        return ""
    parts = [f"### {e['title']}\n{e['body']}" for e in entries]
    return "Kiến thức tham khảo (chỉ dùng phần liên quan):\n\n" + "\n\n".join(parts)
