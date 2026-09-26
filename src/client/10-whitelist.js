    // ---- 白名单管理块：注册进 plugins.detail.section，仅在本插件自己的详情页渲染 ----
    // 位置选择说明：plugins.detail.section 是「追加」型座位，渲染在详情页配置区之后，
    // 因此不与宿主自动生成的配置表单争位；bundle.config / row.config 是「接管」型座位，
    // 注册它们会让宿主不再自动生成该配置页，故此处不使用。
    const PACKAGE_NAME = "dsh-workspace-acl-allow";
    const ROUTE_BASE = "/workspace-acl-allow";

    const CSS = [
      ".dshacla-root{margin-top:12px;border:.5px solid var(--dsw-alias-border-l4);border-radius:16px;background:var(--dsw-alias-bg-layer-3);padding:16px;font:inherit;color:var(--dsw-alias-label-primary)}",
      ".dshacla-head{display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin-bottom:4px}",
      ".dshacla-title{font-size:15px;font-weight:600;line-height:1.4;margin:0}",
      ".dshacla-desc{font-size:12.5px;line-height:1.6;color:var(--dsw-alias-label-tertiary);margin:0 0 12px}",
      ".dshacla-meta{margin-left:auto;font-size:12px;color:var(--dsw-alias-label-tertiary);white-space:nowrap}",
      ".dshacla-knobs{display:flex;flex-wrap:wrap;gap:8px;margin:0 0 12px}",
      ".dshacla-knob{border:.5px solid var(--dsw-alias-border-l2);border-radius:999px;padding:2px 10px;font-size:11.5px;line-height:18px;color:var(--dsw-alias-label-secondary)}",
      ".dshacla-add{display:flex;gap:8px;margin-bottom:12px}",
      ".dshacla-input{flex:1;min-width:0;box-sizing:border-box;border:.5px solid var(--dsw-alias-border-l1);border-radius:8px;padding:7px 10px;font:12px/1.6 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-base)}",
      ".dshacla-input:focus{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}",
      ".dshacla-btn{appearance:none;border:1px solid transparent;border-radius:8px;padding:5px 14px;font:inherit;font-size:13px;line-height:1.5;cursor:pointer;white-space:nowrap}",
      ".dshacla-btn:disabled{opacity:.4;cursor:default}",
      ".dshacla-btn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}",
      ".dshacla-btn-primary{background:var(--dsw-alias-label-primary);color:var(--dsw-alias-bg-layer-3)}",
      ".dshacla-btn-ghost{border-color:var(--dsw-alias-border-l2);background:none;color:var(--dsw-alias-label-secondary)}",
      ".dshacla-btn-ghost:hover:not(:disabled){color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-label-dimmed)}",
      ".dshacla-btn-danger{border-color:var(--dsw-alias-border-l2);background:none;color:var(--dsw-alias-label-secondary)}",
      ".dshacla-btn-danger:hover:not(:disabled){color:#c86464;border-color:#c86464}",
      ".dshacla-btn-tiny{padding:3px 10px;font-size:12px}",
      ".dshacla-list{list-style:none;margin:0;padding:0;border-top:.5px solid var(--dsw-alias-border-l2)}",
      ".dshacla-item{display:flex;align-items:flex-start;gap:10px;padding:10px 0;border-bottom:.5px solid var(--dsw-alias-border-l2)}",
      ".dshacla-item:last-child{border-bottom:0}",
      ".dshacla-item-main{flex:1;min-width:0;display:flex;flex-direction:column;gap:4px}",
      ".dshacla-path{font:12px/1.6 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;word-break:break-all}",
      ".dshacla-sub{font-size:11.5px;line-height:1.5;color:var(--dsw-alias-label-tertiary);word-break:break-all}",
      ".dshacla-ops{display:flex;gap:6px;flex:0 0 auto}",
      ".dshacla-badge{flex:0 0 auto;border-radius:999px;padding:1px 8px;font-size:11px;line-height:17px;font-weight:500;white-space:nowrap;border:.5px solid transparent}",
      ".dshacla-badge-ok{background:color-mix(in srgb,#5d8a6c 18%,transparent);color:#5d8a6c;border-color:color-mix(in srgb,#5d8a6c 35%,transparent)}",
      ".dshacla-badge-bad{background:color-mix(in srgb,#c86464 18%,transparent);color:#c86464;border-color:color-mix(in srgb,#c86464 35%,transparent)}",
      ".dshacla-badge-mute{background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-tertiary);border-color:var(--dsw-alias-border-l2)}",
      ".dshacla-empty{padding:18px 0;font-size:12.5px;color:var(--dsw-alias-label-tertiary)}",
      ".dshacla-note{flex:1;min-width:0;font-size:12px;line-height:1.5;color:var(--dsw-alias-label-secondary)}",
      ".dshacla-note-bad{color:#c86464}",
    ].join("\n");

    let stylesInjected = false;
    function injectStyles() {
      if (stylesInjected) return;
      stylesInjected = true;
      const node = document.createElement("style");
      node.setAttribute("data-dsh-workspace-acl-allow", "");
      node.textContent = CSS;
      document.head.appendChild(node);
    }

    function subjectIsOurs(subject) {
      if (subject === null || typeof subject !== "object") return false;
      if (subject.kind !== "bundle" && subject.kind !== "row") return false;
      const pkg = subject.pkg;
      return pkg !== null && typeof pkg === "object" && pkg.name === PACKAGE_NAME;
    }

    // 本地时区时间：按日期落文案须用本地字段，UTC 会跨日错位。
    function formatTime(value) {
      if (typeof value !== "number" || !Number.isFinite(value)) return "";
      const d = new Date(value);
      const pad = (n) => (n < 10 ? "0" + n : String(n));
      return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()) + " "
        + pad(d.getHours()) + ":" + pad(d.getMinutes()) + ":" + pad(d.getSeconds());
    }

    function statusLabel(status) {
      if (typeof status !== "string" || status.length === 0) return "未知";
      if (status === "granted") return "已授权";
      if (status === "skipped:missing") return "目录不存在";
      if (status === "skipped:blacklist") return "受保护目录，已拒绝";
      if (status === "skipped:not-windows") return "非 Windows";
      if (status === "skipped:empty") return "空路径";
      if (status === "skipped:malformed") return "记录异常";
      if (status === "skipped:workspace-unregistered") return "工作区已移除（不撤权）";
      if (status === "failed:no-grantee") return "无法解析当前用户";
      if (status.startsWith("failed:")) return "授权失败（退出码 " + status.slice(7) + "）";
      if (status.startsWith("skipped:")) return "已跳过（" + status.slice(8) + "）";
      return status;
    }

    function statusKind(status) {
      if (status === "granted") return "ok";
      if (typeof status === "string" && status.startsWith("failed:")) return "bad";
      return "mute";
    }

    async function apiJson(path, init) {
      const response = await fetch(path, Object.assign({ cache: "no-store", credentials: "same-origin" }, init || {}));
      const text = await response.text();
      let data = null;
      try { data = text.length > 0 ? JSON.parse(text) : null; } catch { /* 非 JSON 响应按空处理 */ }
      if (!response.ok) {
        const base = (data && (data.error || data.message)) || (response.status + " " + response.statusText);
        // 404/405 表示请求落到了宿主的静态兜底，说明插件服务端接口未就位。
        const hint = response.status === 404 || response.status === 405
          ? "（宿主的插件接口未就位，请重启 dsh 后重试）"
          : "";
        throw new Error(base + hint);
      }
      return data;
    }

    // 变更结果如实回显：未授权/失败/跳过都不入库，只回显，否则界面会以为什么都没发生。
    function describeOutcome(action, data) {
      const target = data && typeof data.path === "string" ? data.path : "";
      if (action === "remove") {
        return data && data.removed
          ? { bad: false, text: "已移除条目：" + target + "（未改动目录上已有的权限）" }
          : { bad: true, text: "该条目不存在：" + target };
      }
      const entry = data ? data.entry : null;
      const status = entry ? entry.status : undefined;
      if (status === "granted") return { bad: false, text: "已授权：" + target };
      if (status === "skipped:missing") return { bad: true, text: "未授权（目录不存在）：" + target };
      if (status === "skipped:blacklist") return { bad: true, text: "未授权（受保护目录，已拒绝）：" + target };
      if (status === "skipped:not-windows") return { bad: true, text: "未授权（非 Windows 平台）" };
      if (status === "skipped:empty") return { bad: true, text: "请输入目录路径" };
      if (typeof status === "string" && status.startsWith("failed:")) {
        return {
          bad: true,
          text: "授权失败（退出码 " + status.slice(7) + "）：" + target
            + (entry.lastError ? " — " + entry.lastError : ""),
        };
      }
      return { bad: true, text: "未授权：" + target + " → " + statusLabel(status) };
    }

    function Badge(props) {
      return React.createElement("span", { className: "dshacla-badge dshacla-badge-" + statusKind(props.status) },
        statusLabel(props.status));
    }

    function WhitelistSection(props) {
      // 详情页对每个主题都会问一次；非本插件主题不渲染任何内容。
      const ours = subjectIsOurs(props.subject);
      const [view, setView] = React.useState(null);
      const [busy, setBusy] = React.useState(false);
      const [draft, setDraft] = React.useState("");
      const [note, setNote] = React.useState("");
      const [noteBad, setNoteBad] = React.useState(false);

      const load = React.useCallback(() => {
        apiJson(ROUTE_BASE + "/state")
          .then((data) => { if (data && data.ok) setView(data); })
          .catch((error) => { setNoteBad(true); setNote("读取失败：" + String(error.message || error)); });
      }, []);

      React.useEffect(() => {
        if (!ours) return undefined;
        load();
        return undefined;
      }, [ours, load]);

      if (!ours) return null;

      const run = (action, endpoint, body) => {
        if (busy) return;
        setBusy(true);
        setNote("");
        setNoteBad(false);
        apiJson(endpoint, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body || {}),
        })
          .then((data) => {
            const outcome = describeOutcome(action, data);
            setNoteBad(outcome.bad);
            setNote(outcome.text);
            load();
          })
          .catch((error) => { setNoteBad(true); setNote("操作失败：" + String(error.message || error)); })
          .finally(() => setBusy(false));
      };

      const list = view && Array.isArray(view.whitelist) ? view.whitelist : [];
      const config = (view && view.config) || {};

      const knobs = React.createElement("div", { className: "dshacla-knobs" },
        React.createElement("span", { className: "dshacla-knob" },
          "工作区事件：" + (config.watchWorkspaces === false ? "关" : "开")),
        React.createElement("span", { className: "dshacla-knob" },
          "递归子项（/T）：" + (config.deepGrant ? "开" : "关")),
        React.createElement("span", { className: "dshacla-knob" },
          "失败冷却：" + Math.round((Number(config.retryCooldownMs) || 0) / 60000) + " 分钟"));

      const rows = list.length === 0
        ? React.createElement("li", { className: "dshacla-empty" },
            "还没有条目。在 dsh 中添加工作区，或在此手动新增路径。"
            + "只有成功授权的目录会进入清单；被拒绝或失败的只看下方结果行。")
        : list.map((item) => React.createElement("li", { className: "dshacla-item", key: item.path },
            React.createElement("div", { className: "dshacla-item-main" },
              React.createElement("span", { className: "dshacla-path" }, item.path),
              React.createElement("span", { className: "dshacla-sub" },
                (item.at ? formatTime(item.at) : "—")
                + (item.attempts ? " · 尝试 " + item.attempts + " 次" : "")
                + (item.lastError ? " · " + item.lastError : ""))),
            React.createElement("span", { className: "dshacla-ops" },
              React.createElement("span", { className: "dshacla-badge dshacla-badge-" + statusKind(item.status) },
                statusLabel(item.status)),
              React.createElement("button", {
                type: "button",
                className: "dshacla-btn dshacla-btn-ghost dshacla-btn-tiny",
                disabled: busy,
                onClick: () => run("regrant", ROUTE_BASE + "/regrant", { path: item.path }),
              }, "重新授权"),
              React.createElement("button", {
                type: "button",
                className: "dshacla-btn dshacla-btn-danger dshacla-btn-tiny",
                disabled: busy,
                onClick: () => run("remove", ROUTE_BASE + "/remove", { path: item.path }),
              }, "移除"))));

      const supported = view === null || view.supported !== false;

      return React.createElement("section", { className: "dshacla-root", "aria-label": "工作区授权白名单" },
        React.createElement("div", { className: "dshacla-head" },
          React.createElement("h3", { className: "dshacla-title" }, "工作区授权白名单"),
          React.createElement("span", { className: "dshacla-meta" },
            view === null ? "读取中…" : "共 " + list.length + " 条"),
          React.createElement("button", {
            type: "button",
            className: "dshacla-btn dshacla-btn-ghost dshacla-btn-tiny",
            disabled: busy,
            onClick: () => { setNote(""); load(); },
          }, "刷新")),
        React.createElement("p", { className: "dshacla-desc" },
          "只处理此处显式声明的目录：为当前用户补一条完全控制的 ACL 条目，使 dsh 沙箱的授权调用得以通过。"
          + "本插件不会撤销任何权限，移除条目也不会改动目录上已有的 ACL。"),
        supported ? null : React.createElement("p", { className: "dshacla-desc" },
          "当前平台非 Windows，本插件不生效。"),
        supported ? knobs : null,
        supported ? React.createElement("div", { className: "dshacla-add" },
          React.createElement("input", {
            className: "dshacla-input",
            type: "text",
            spellCheck: false,
            placeholder: "输入目录的绝对路径，回车即授权",
            value: draft,
            disabled: busy,
            onChange: (event) => setDraft(event.target.value),
            onKeyDown: (event) => {
              if (event.key !== "Enter") return;
              const value = draft.trim();
              if (value.length === 0) return;
              run("add", ROUTE_BASE + "/add", { path: value });
              setDraft("");
            },
          }),
          React.createElement("button", {
            type: "button",
            className: "dshacla-btn dshacla-btn-primary",
            disabled: busy || draft.trim().length === 0,
            onClick: () => {
              const value = draft.trim();
              if (value.length === 0) return;
              run("add", ROUTE_BASE + "/add", { path: value });
              setDraft("");
            },
          }, busy ? "处理中…" : "新增授权")) : null,
        supported ? React.createElement("ul", { className: "dshacla-list" }, rows) : null,
        note.length > 0
          ? React.createElement("p", { className: "dshacla-note" + (noteBad ? " dshacla-note-bad" : "") }, note)
          : null,
        view && typeof view.stateFile === "string"
          ? React.createElement("p", { className: "dshacla-sub" }, "状态文件：" + view.stateFile)
          : null);
    }
