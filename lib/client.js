window.__ModuleLoader__.load({
	id: "dsh-ccswitch",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
		//#region src/client/search.ts
		const MODEL_ITEM_SELECTOR = "button[role=\"menuitemradio\"][title]";
		const MODEL_GROUP_SELECTOR = "section[role=\"group\"]";
		const FILTER_ATTRIBUTE = "data-dsh-ccswitch-model-filtered";
		const SEARCH_CONTROL_ATTRIBUTE = "data-dsh-ccswitch-model-search";
		function normalized(value) {
			return value.trim().toLocaleLowerCase();
		}
		function modelSearchText(model) {
			return [
				model.querySelector("[class*=\"modelName\"]")?.textContent?.trim() ?? "",
				model.getAttribute("title") ?? "",
				model.getAttribute("aria-label") ?? ""
			].filter((value) => value.length > 0).join(" ");
		}
		function directGroups(container) {
			return Array.from(container.children).filter((child) => child.matches(MODEL_GROUP_SELECTOR));
		}
		/** Filter one rendered model list by model title only. */
		function filterModelGroups(groups, query) {
			const needle = normalized(query);
			let matchedModels = 0;
			let totalModels = 0;
			for (const group of directGroups(groups)) {
				let groupMatches = 0;
				const models = group.querySelectorAll(MODEL_ITEM_SELECTOR);
				for (const model of models) {
					totalModels += 1;
					const matches = normalized(modelSearchText(model)).includes(needle);
					model.hidden = !matches;
					model.setAttribute(FILTER_ATTRIBUTE, matches ? "visible" : "hidden");
					if (matches) groupMatches += 1;
				}
				group.hidden = groupMatches === 0;
				group.setAttribute(FILTER_ATTRIBUTE, groupMatches > 0 ? "visible" : "hidden");
				matchedModels += groupMatches;
			}
			return {
				matchedModels,
				totalModels
			};
		}
		function restoreModelGroups(groups) {
			for (const group of directGroups(groups)) {
				group.hidden = false;
				group.removeAttribute(FILTER_ATTRIBUTE);
				for (const model of group.querySelectorAll(MODEL_ITEM_SELECTOR)) {
					model.hidden = false;
					model.removeAttribute(FILTER_ATTRIBUTE);
				}
			}
		}
		function visibleModels(groups) {
			return Array.from(groups.querySelectorAll(MODEL_ITEM_SELECTOR)).filter((model) => !model.hidden && !model.disabled && !model.closest(MODEL_GROUP_SELECTOR)?.hidden);
		}
		function findModelGroups(menu) {
			if (directGroups(menu).some((group) => group.querySelector(MODEL_ITEM_SELECTOR) !== null)) return menu;
			const group = Array.from(menu.querySelectorAll(MODEL_GROUP_SELECTOR)).find((candidate) => candidate.querySelector(MODEL_ITEM_SELECTOR) !== null);
			if (group === void 0) return null;
			const container = group.parentElement;
			return container !== null && container !== menu && menu.contains(container) ? container : null;
		}
		/**
		* DSH 0.2.0-rc.2 renders its own model search (a `role="searchbox"` input in the
		* pane's search row) whenever a provider lists more than four models. Injecting
		* a second box would leave two filters fighting over the same `hidden` flags.
		*/
		function hasNativeSearch(menu) {
			const surface = menu.parentElement;
			return surface !== null && surface.querySelector("input[role=\"searchbox\"]") !== null;
		}
		/** Add a search input to one currently rendered model pane. */
		function enhanceModelMenu(menu, groups) {
			const control = menu.ownerDocument.createElement("div");
			control.setAttribute(SEARCH_CONTROL_ATTRIBUTE, "");
			control.setAttribute("role", "search");
			const input = menu.ownerDocument.createElement("input");
			input.type = "search";
			input.placeholder = "搜索模型";
			input.setAttribute("aria-label", "按模型名称搜索");
			input.autocomplete = "off";
			input.spellcheck = false;
			const noResults = menu.ownerDocument.createElement("div");
			noResults.className = "dsh-ccswitch-model-search-empty";
			noResults.textContent = "没有匹配的模型";
			noResults.setAttribute("role", "status");
			noResults.hidden = true;
			control.append(input, noResults);
			groups.before(control);
			const refresh = () => {
				if (!control.isConnected && groups.isConnected) groups.before(control);
				const result = filterModelGroups(groups, input.value);
				noResults.hidden = normalized(input.value).length === 0 || result.matchedModels > 0 || result.totalModels === 0;
			};
			const onInput = () => {
				refresh();
			};
			const onKeyDown = (event) => {
				if (event.key === "Escape" && normalized(input.value).length > 0) {
					event.preventDefault();
					event.stopPropagation();
					input.value = "";
					refresh();
					input.focus();
					return;
				}
				if (event.key === "ArrowDown" || event.key === "ArrowUp") {
					const models = visibleModels(groups);
					const target = event.key === "ArrowDown" ? models[0] : models.at(-1);
					if (target !== void 0) {
						event.preventDefault();
						event.stopPropagation();
						target.focus();
					}
				}
			};
			input.addEventListener("input", onInput);
			input.addEventListener("change", onInput);
			input.addEventListener("search", onInput);
			input.addEventListener("keydown", onKeyDown);
			const view = menu.ownerDocument.defaultView;
			const timer = view?.setInterval(refresh, 100);
			refresh();
			return {
				groups,
				input,
				noResults,
				refresh,
				dispose() {
					input.removeEventListener("input", onInput);
					input.removeEventListener("change", onInput);
					input.removeEventListener("search", onInput);
					input.removeEventListener("keydown", onKeyDown);
					if (timer !== void 0) view?.clearInterval(timer);
					restoreModelGroups(groups);
					control.remove();
				}
			};
		}
		/** Track model panes across menu open, close, reload, and provider updates. */
		function installModelSearch(root = document) {
			const controllers = /* @__PURE__ */ new Map();
			const sync = () => {
				for (const [menu, controller] of controllers) {
					if ((menu.isConnected && !hasNativeSearch(menu) ? findModelGroups(menu) : null) === controller.groups) {
						controller.refresh();
						continue;
					}
					controller.dispose();
					controllers.delete(menu);
				}
				for (const menu of root.querySelectorAll("[role=\"menu\"]")) {
					if (controllers.has(menu)) continue;
					const groups = findModelGroups(menu);
					if (groups !== null && !hasNativeSearch(menu)) controllers.set(menu, enhanceModelMenu(menu, groups));
				}
			};
			const Observer = root.defaultView?.MutationObserver ?? globalThis.MutationObserver;
			if (Observer === void 0) return () => void 0;
			const observer = new Observer(sync);
			observer.observe(root.body ?? root.documentElement, {
				childList: true,
				subtree: true
			});
			sync();
			return () => {
				observer.disconnect();
				for (const controller of controllers.values()) controller.dispose();
				controllers.clear();
			};
		}
		//#endregion
		//#region src/client/import-panel.ts
		const discoveryLabels = {
			configured: "仅 CC Switch 配置模型",
			pending: "正在获取接口列表",
			remote: "接口已返回列表",
			failed: "接口获取失败，保留已有模型"
		};
		function ImportPanel({ remote }) {
			const [view, setView] = (0, react.useState)();
			const [selected, setSelected] = (0, react.useState)([]);
			const [filter, setFilter] = (0, react.useState)("");
			const [busy, setBusy] = (0, react.useState)(false);
			const [failure, setFailure] = (0, react.useState)("");
			const [outcomes, setOutcomes] = (0, react.useState)([]);
			const load = async () => {
				const answer = await remote.list();
				if (!answer.ok) throw new Error(answer.error.message);
				setView(answer.value);
				setSelected((current) => current.filter((id) => answer.value.rows.some((row) => row.provider === id && row.eligible)));
			};
			(0, react.useEffect)(() => {
				let active = true;
				remote.list().then((answer) => {
					if (!active) return;
					if (answer.ok) setView(answer.value);
					else setFailure(answer.error.message);
				}).catch(() => {
					if (active) setFailure("无法读取 CC Switch 导入服务，请确认插件已启用并完整重启 DSH。");
				});
				return () => {
					active = false;
				};
			}, [remote]);
			const run = async (action) => {
				if (busy) return;
				setBusy(true);
				setFailure("");
				try {
					if (action === "reload") await load();
					else if (action === "refresh") {
						const answer = await remote.refresh(selected);
						if (!answer.ok) throw new Error(answer.error.message);
						setView(answer.value);
					} else {
						const answer = await remote.importProviders(selected);
						if (!answer.ok) throw new Error(answer.error.message);
						setOutcomes(answer.value);
						await load();
					}
				} catch {
					setFailure("操作未完成，请重新读取后重试；源 API Key 与 DSH 写入权限须有效。");
				} finally {
					setBusy(false);
				}
			};
			const toggle = (provider) => setSelected((current) => current.includes(provider) ? current.filter((id) => id !== provider) : [...current, provider]);
			const rows = view?.rows.filter((row) => `${row.name} ${row.appType} ${row.provider}`.toLowerCase().includes(filter.trim().toLowerCase())) ?? [];
			const button = (label, onClick, disabled = false) => (0, react.createElement)("button", {
				type: "button",
				onClick,
				disabled: busy || disabled
			}, label);
			return (0, react.createElement)("section", {
				className: "dsh-ccswitch-import",
				"aria-label": "CC Switch 原生导入"
			}, (0, react.createElement)("h3", null, "从 CC Switch 导入"), (0, react.createElement)("p", null, "一次性导入 API Key 供应商及当前模型列表，之后在 DSH 原生卡片中编辑接口、密钥和模型；CC Switch 不会覆盖你的修改。"), (0, react.createElement)("p", null, "OAuth/登录令牌和当前 DSH 尚不支持的协议继续使用动态连接。原有会话连接不会被删除或自动改选。"), view !== void 0 && !view.available ? (0, react.createElement)("p", { role: "alert" }, "请启用 DSH 的 llm-pi-ai 原生模型适配器后再导入。") : null, view !== void 0 && !view.writable ? (0, react.createElement)("p", { role: "alert" }, "当前 DSH 配置为只读，不能导入。") : null, (0, react.createElement)("div", { className: "dsh-ccswitch-import-actions" }, button("重新读取 CC Switch", () => void run("reload")), button("选择可导入项", () => setSelected(rows.filter((row) => row.eligible).slice(0, 128).map((row) => row.provider)), !rows.some((row) => row.eligible)), button("获取所选模型列表", () => void run("refresh"), selected.length === 0), button(busy ? "处理中…" : `导入所选 (${selected.length})`, () => void run("import"), selected.length === 0)), (0, react.createElement)("input", {
				type: "search",
				placeholder: "筛选供应商名称 / Claude / Codex / Gemini",
				"aria-label": "筛选 CC Switch 导入供应商",
				value: filter,
				onChange: (event) => setFilter(event.currentTarget.value)
			}), (0, react.createElement)("p", { className: "dsh-ccswitch-import-note" }, "“接口获取失败”不是完整目录；可先刷新，导入后也能手动补充模型 ID。接口返回列表不保证每个模型都可通过该供应商协议调用。"), (0, react.createElement)("ul", { className: "dsh-ccswitch-import-rows" }, rows.map((row) => (0, react.createElement)("li", { key: row.provider }, (0, react.createElement)("label", null, (0, react.createElement)("input", {
				type: "checkbox",
				checked: selected.includes(row.provider),
				disabled: busy || !row.eligible,
				onChange: () => toggle(row.provider)
			}), (0, react.createElement)("span", null, `${row.name} · ${row.appType} · ${row.models} 个模型`)), (0, react.createElement)("small", null, row.imported ? row.reason : `${discoveryLabels[row.discovery]}${row.reason ? `；${row.reason}` : ""}`)))), view !== void 0 && rows.length === 0 ? (0, react.createElement)("p", null, view.rows.length === 0 ? "未读取到 CC Switch 供应商，请检查数据库位置与供应商筛选。" : "没有匹配的供应商。") : null, failure ? (0, react.createElement)("p", { role: "alert" }, failure) : null, outcomes.length > 0 ? (0, react.createElement)("ul", {
				role: "status",
				"aria-live": "polite"
			}, outcomes.map((outcome) => (0, react.createElement)("li", { key: outcome.provider }, `${view?.rows.find((row) => row.provider === outcome.provider)?.name ?? outcome.provider}：${outcome.message}`))) : null);
		}
		//#endregion
		//#region src/import-contract.ts
		const descriptor = (method, parameters, cancellable = false) => ({
			id: `src:ccswitch#ccswitch/${method}`,
			service: "ccswitch",
			namespace: "ccswitch",
			method,
			invocation: { kind: "direct" },
			parameters: parameters.map((name) => ({
				name,
				wire: name,
				source: "json",
				codec: { mode: "src-json" }
			})),
			...cancellable ? { cancellation: { parameter: "signal" } } : {},
			result: { mode: "src-json" }
		});
		const importRemoteContribution = {
			package: "dsh-ccswitch",
			descriptors: [
				descriptor("list", []),
				descriptor("refresh", ["providers"], true),
				descriptor("importProviders", ["providers"], true)
			]
		};
		//#endregion
		//#region src/client/index.ts
		const PACKAGE_ID = "dsh-ccswitch";
		const styles = `
.dsh-ccswitch-import { display:flex; flex-direction:column; gap:10px; margin-top:16px; padding:16px; border:1px solid var(--dsw-alias-border-l2); border-radius:12px; color:var(--dsw-alias-label-primary); font-size:13px; }
.dsh-ccswitch-import h3, .dsh-ccswitch-import p { margin:0; }
.dsh-ccswitch-import-actions { display:flex; flex-wrap:wrap; gap:8px; }
.dsh-ccswitch-import button { cursor:pointer; padding:7px 10px; border:1px solid var(--dsw-alias-border-l2); border-radius:6px; background:transparent; color:inherit; font:inherit; }
.dsh-ccswitch-import button:disabled { cursor:default; opacity:.5; }
.dsh-ccswitch-import input[type="search"] { width:100%; box-sizing:border-box; padding:8px; border:1px solid var(--dsw-alias-border-l2); border-radius:6px; background:transparent; color:inherit; }
.dsh-ccswitch-import-rows { max-height:360px; overflow:auto; display:flex; flex-direction:column; gap:10px; list-style:none; margin:0; padding:0; }
.dsh-ccswitch-import-rows li { display:flex; flex-direction:column; gap:4px; }
.dsh-ccswitch-import-rows label { display:flex; align-items:center; gap:8px; }
.dsh-ccswitch-import small, .dsh-ccswitch-import-note { color:var(--dsw-alias-label-tertiary); }
.dsh-ccswitch-import [role="alert"] { color:var(--dsw-alias-state-error-primary); }
[data-dsh-ccswitch-model-search] {
  flex: 0 0 auto;
  padding: 4px 4px 6px;
}

[data-dsh-ccswitch-model-filtered="hidden"] {
  display: none !important;
}

[data-dsh-ccswitch-model-search] input[type="search"] {
  box-sizing: border-box;
  width: 100%;
  height: 32px;
  padding: 0 9px;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 6px;
  outline: none;
  background: transparent;
  color: var(--dsw-alias-label-primary);
  font-family: var(--dsw-font-family);
  font-size: 13px;
  font-weight: 400;
  line-height: 20px;
  letter-spacing: 0;
}

[data-dsh-ccswitch-model-search] input[type="search"]::placeholder {
  color: var(--dsw-alias-label-tertiary);
}

[data-dsh-ccswitch-model-search] input[type="search"]:focus-visible {
  border-color: var(--dsw-alias-border-l4);
  box-shadow: 0 0 0 2px var(--dsw-alias-border-l2);
}

.dsh-ccswitch-model-search-empty {
  padding: 10px 6px 4px;
  color: var(--dsw-alias-label-tertiary);
  font-size: 13px;
  font-weight: 400;
  line-height: 20px;
  letter-spacing: 0;
}
`;
		const inject = ["slots", "remote"];
		function apply(ctx) {
			const style = document.createElement("style");
			style.dataset.plugin = PACKAGE_ID;
			style.textContent = styles;
			document.head.append(style);
			ctx.effect(() => () => style.remove(), "dsh-ccswitch: model search styles");
			ctx.effect(() => installModelSearch(), "dsh-ccswitch: model name search");
			ctx.effect(async () => {
				const disposeRemote = await ctx.remote.$mount(importRemoteContribution);
				ctx.slots.inject("settings.models.footer", () => ctx.slots.register({
					name: "settings.models.footer",
					id: PACKAGE_ID,
					order: 20,
					inject: () => ({ remote: ctx.remote.ccswitch })
				}, ImportPanel));
				return disposeRemote;
			}, "dsh-ccswitch: native model import");
		}
		//#endregion
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});

//# sourceMappingURL=client.js.map