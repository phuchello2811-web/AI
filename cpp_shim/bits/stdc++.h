#pragma once
#include <cassert>
#include <cctype>
#include <cerrno>
#include <cfloat>
#include <climits>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <ctime>
#include <cstdint>
#include <cinttypes>
#include <algorithm>
#include <array>
#include <bitset>
#include <chrono>
#include <complex>
#include <deque>
#include <functional>
#include <iomanip>
#include <iostream>
#include <istream>
#include <ostream>
#include <sstream>
#include <fstream>
#include <iterator>
#include <limits>
#include <list>
#include <map>
#include <memory>
#include <numeric>
#include <queue>
#include <random>
#include <ratio>
#include <set>
#include <stack>
#include <string>
#include <tuple>
#include <type_traits>
#include <unordered_map>
#include <unordered_set>
#include <utility>
#include <valarray>
#include <vector>
#include <optional>
#include <variant>
#include <string_view>
#include <cstddef>
#include <regex>
#include <atomic>
#include <thread>
#include <mutex>
#ifdef _LIBCPP_VERSION
inline int __lg(unsigned long long x) { return 63 - __builtin_clzll(x); }
inline int __lg(long long x) { return __lg((unsigned long long)x); }
inline int __lg(unsigned long x) { return __lg((unsigned long long)x); }
inline int __lg(long x) { return __lg((unsigned long long)x); }
inline int __lg(unsigned x) { return __lg((unsigned long long)x); }
inline int __lg(int x) { return __lg((unsigned long long)x); }
template <class T> T __gcd(T a, T b) { while (b) { T t = a % b; a = b; b = t; } return a; }
#endif
