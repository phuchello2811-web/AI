// A UI audit that runs inside a generated page (in a hidden sandboxed frame) and reports measurable design
// problems back to the page that opened it: horizontal overflow, text that is too small, low-contrast
// (WCAG ratios) or cut off, tap targets too small for a finger, images without alt text, unlabeled buttons,
// and a missing viewport tag. With `interact`, it then uses the page like a person would: clicks every
// button, link and control, flagging the ones that do nothing and forms that would reload the page (errors
// thrown by clicks are reported by the page's error probe, labelled with the action). This gives the model
// "eyes" and "hands": the issues are fed back so it can fix them.
//
// `uiAudit` is serialised with Function.prototype.toString and injected, so it must be self-contained.

export async function uiAudit(token, label, interact) {
  const issues = [];
  const add = (m) => { if (issues.length < 10 && !issues.includes(m)) issues.push(m); };
  const W = document.documentElement.clientWidth;

  const describe = (el) => {
    const cls = typeof el.className === "string" && el.className.trim() ? "." + el.className.trim().split(/\s+/)[0] : "";
    const text = (el.textContent || "").trim().replace(/\s+/g, " ").slice(0, 24);
    return `<${el.tagName.toLowerCase()}${el.id ? "#" + el.id : cls}>` + (text ? ` "${text}"` : "");
  };
  const parse = (c) => {
    const m = /rgba?\(([\d.]+)[ ,]+([\d.]+)[ ,]+([\d.]+)(?:[ ,/]+([\d.]+))?/.exec(c || "");
    return m ? [+m[1], +m[2], +m[3], m[4] === undefined ? 1 : +m[4]] : null;
  };
  const lum = ([r, g, b]) => {
    const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
  };
  const blend = (fg, bg) => fg.slice(0, 3).map((v, i) => v * fg[3] + bg[i] * (1 - fg[3]));
  // The solid colour behind an element, or null when it sits on an image or gradient (contrast unknown).
  const background = (el) => {
    for (let e = el; e; e = e.parentElement) {
      const cs = getComputedStyle(e);
      if (cs.backgroundImage && cs.backgroundImage !== "none") return null;
      const c = parse(cs.backgroundColor);
      if (c && c[3] > 0.05) return c[3] >= 1 ? c : null;
    }
    return [255, 255, 255, 1];
  };
  const visible = (el, cs) => {
    if (cs.display === "none" || cs.visibility === "hidden" || +cs.opacity === 0) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };

  if (!document.querySelector('meta[name="viewport"]')) {
    add('Thiếu <meta name="viewport" content="width=device-width, initial-scale=1">: trang không co giãn theo màn hình điện thoại.');
  }
  const scrollW = document.documentElement.scrollWidth;
  if (scrollW > W + 2) {
    const wide = [...document.body.querySelectorAll("*")].filter((el) => {
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.right > W + 2 && getComputedStyle(el).position !== "fixed";
    });
    // Report the outermost offenders, not every descendant.
    const roots = wide.filter((el) => !wide.includes(el.parentElement)).slice(0, 3).map(describe);
    add(`Trang bị tràn ngang ở khổ ${label}: rộng ${scrollW}px trong khi màn hình ${W}px` + (roots.length ? `, do ${roots.join(", ")}` : "") + ".");
  }

  const small = [], faint = [], tiny = [];
  const textEls = [...document.body.querySelectorAll("*")].filter((el) =>
    [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim().length > 1)).slice(0, 500);
  for (const el of textEls) {
    const cs = getComputedStyle(el);
    if (!visible(el, cs)) continue;
    const size = parseFloat(cs.fontSize);
    if (size < 12) small.push(`${describe(el)} (${size}px)`);
    const fg = parse(cs.color), bg = background(el);
    if (!fg || fg[3] < 0.1 || !bg) continue;
    const a = lum(blend(fg, bg)), b = lum(bg);
    const ratio = (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
    const large = size >= 24 || (size >= 18.6 && +cs.fontWeight >= 700);
    if (ratio < (large ? 3 : 4.5)) faint.push(`${describe(el)} tỉ lệ ${ratio.toFixed(1)}:1`);
  }
  if (small.length) add(`Chữ quá nhỏ (dưới 12px) ở ${small.length} chỗ, ví dụ ${small.slice(0, 3).join(", ")}.`);
  if (faint.length) add(`Chữ không đủ tương phản với nền (cần ≥ 4.5:1, chữ lớn ≥ 3:1) ở ${faint.length} chỗ, ví dụ ${faint.slice(0, 3).join(", ")}.`);

  if (W < 600) {
    for (const el of document.querySelectorAll("a, button, input, select, textarea, [role=button]")) {
      const cs = getComputedStyle(el);
      if (!visible(el, cs) || cs.position === "fixed" && el.getBoundingClientRect().width === 0) continue;
      // A checkbox or radio inside its label is tapped through the whole label.
      if (/^(checkbox|radio)$/.test(el.type) && el.closest("label")) continue;
      const r = el.getBoundingClientRect();
      if (r.width < 32 || r.height < 32) tiny.push(`${describe(el)} ${Math.round(r.width)}×${Math.round(r.height)}px`);
    }
    if (tiny.length) add(`Nút/liên kết quá nhỏ để bấm bằng ngón tay (nên ≥ 44×44px) ở ${tiny.length} chỗ, ví dụ ${tiny.slice(0, 3).join(", ")}.`);
  }
  const clipped = textEls.filter((el) => {
    const cs = getComputedStyle(el);
    if (!visible(el, cs) || cs.textOverflow === "ellipsis" || !/(hidden|clip)/.test(cs.overflow + cs.overflowX + cs.overflowY)) return false;
    return el.scrollWidth > el.clientWidth + 2 || el.scrollHeight > el.clientHeight + 2;
  });
  if (clipped.length) add(`Chữ bị cắt mất trong khung (overflow hidden) ở ${clipped.length} chỗ, ví dụ ${clipped.slice(0, 3).map(describe).join(", ")}.`);
  const noAlt = [...document.images].filter((img) => !img.hasAttribute("alt")).length;
  if (noAlt) add(`${noAlt} ảnh thiếu thuộc tính alt.`);
  const unnamed = [...document.querySelectorAll("button, a[href]")].filter((el) =>
    !(el.textContent || "").trim() && !el.getAttribute("aria-label") && !el.getAttribute("title") && !el.querySelector("img[alt]")).length;
  if (unnamed) add(`${unnamed} nút/liên kết không có chữ hay aria-label (trình đọc màn hình không biết nó làm gì).`);

  if (interact) await useThePage();
  parent.postMessage({ cmAudit: token, label, issues }, "*");

  // Click through the page like a user. Dialog functions are stubbed (the sandbox blocks them) and count as
  // a reaction; form submissions that nothing prevents are reported, then stopped so the page stays put.
  async function useThePage() {
    let reacted = false, errored = false;
    addEventListener("error", () => { errored = true; }, true);
    window.alert = () => { reacted = true; };
    window.confirm = () => { reacted = true; return true; };
    window.prompt = () => { reacted = true; return "Thử"; };
    window.open = () => { reacted = true; return null; };
    const reloads = [];
    addEventListener("submit", (e) => {
      if (!e.defaultPrevented) { reloads.push(describe(e.target)); e.preventDefault(); }
      reacted = true;
    });
    // Fill the form fields so submit handlers get plausible data.
    for (const el of document.querySelectorAll("input, textarea")) {
      const type = (el.type || "text").toLowerCase();
      if (el.value || ["hidden", "checkbox", "radio", "file", "submit", "button", "range", "color"].includes(type)) continue;
      el.value = { email: "ban@example.com", number: el.min || "1", tel: "0912345678", url: "https://example.com", date: "2026-10-25", time: "09:30", password: "Matkhau123!" }[type] || "Thử nghiệm";
      el.dispatchEvent(new Event("input", { bubbles: true }));
    }
    const targets = [...document.querySelectorAll("button, [role=button], a[href^='#'], input[type=checkbox], input[type=radio], input[type=submit], select, summary, [onclick]")]
      .filter((el) => !el.disabled && visible(el, getComputedStyle(el))).slice(0, 30);
    const dead = [];
    for (const el of targets) {
      if (!el.isConnected) continue;
      window.__cmAction = `bấm ${describe(el)}`;
      reacted = false;
      errored = false;
      let changes = 0;
      const observer = new MutationObserver((list) => { changes += list.length; });
      observer.observe(document.documentElement, { subtree: true, childList: true, attributes: true, characterData: true });
      const hash = location.hash, scroll = scrollY;
      try {
        if (el.tagName === "SELECT") { el.selectedIndex = (el.selectedIndex + 1) % Math.max(1, el.options.length); el.dispatchEvent(new Event("change", { bubbles: true })); }
        else el.click();
      } catch (e) { /* reported by the error probe */ }
      await new Promise((r) => setTimeout(r, 150));
      observer.disconnect();
      // A click that threw is already reported as an error.
      if (!changes && !reacted && !errored && location.hash === hash && scrollY === scroll && el.tagName !== "SELECT") dead.push(describe(el));
    }
    window.__cmAction = "";
    if (dead.length) add(`Bấm vào nhưng trang không có phản ứng gì ở ${dead.length} chỗ, ví dụ ${dead.slice(0, 4).join(", ")} — kiểm tra lại sự kiện click.`);
    if (reloads.length) add(`Gửi form làm tải lại cả trang (mất dữ liệu đang nhập) ở ${reloads.slice(0, 2).join(", ")} — cần e.preventDefault() trong sự kiện submit.`);
  }
}
