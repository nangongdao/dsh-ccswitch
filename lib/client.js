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
		const APP_LABEL = {
			claude: "Claude",
			codex: "Codex",
			gemini: "Gemini"
		};
		const DISCOVERY = {
			configured: "模型列表来自 CC Switch 配置",
			pending: "正在读取接口模型列表…",
			remote: "模型列表来自供应商接口",
			failed: "接口读取失败，沿用已知模型"
		};
		/** One request per chunk keeps a long import responsive and gives real progress. */
		const CHUNK = 5;
		const MAX_SELECTION = 128;
		/** Selection key for a group-wide confirmation, which has no single provider. */
		const BATCH = "*";
		const VERB = {
			import: "正在导入",
			update: "正在更新模型",
			key: "正在写回密钥",
			remove: "正在移除"
		};
		const toneOf = (status) => status === "skipped" ? "warn" : status === "failed" ? "error" : "success";
		function ImportPanel({ remote }) {
			const [view, setView] = (0, react.useState)();
			const [selected, setSelected] = (0, react.useState)([]);
			const [marked, setMarked] = (0, react.useState)([]);
			const [filter, setFilter] = (0, react.useState)("");
			const [phase, setPhase] = (0, react.useState)("");
			const [failure, setFailure] = (0, react.useState)("");
			const [feedback, setFeedback] = (0, react.useState)([]);
			const [progress, setProgress] = (0, react.useState)("");
			const [confirming, setConfirming] = (0, react.useState)("");
			const reload = async () => {
				const answer = await remote.list();
				if (!answer.ok) throw new Error(answer.error.message);
				setView(answer.value);
				setSelected((current) => current.filter((id) => answer.value.rows.some((row) => row.provider === id && row.eligible)));
				setMarked((current) => current.filter((id) => answer.value.rows.some((row) => row.provider === id && row.imported)));
				return answer.value;
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
			const report = (outcomes, rows) => {
				setFeedback(outcomes.map((outcome) => {
					const name = rows.find((row) => row.provider === outcome.provider)?.name ?? "该线路";
					return {
						key: outcome.provider,
						name,
						tone: toneOf(outcome.status),
						message: outcome.message,
						text: `${name}：${outcome.message}`
					};
				}));
			};
			const guard = async (next, action) => {
				if (phase !== "") return;
				setPhase(next);
				setFailure("");
				try {
					await action();
				} catch {
					setFailure("操作未完成。请重新读取后重试；源 API Key 与 DSH 写入权限须有效。");
				} finally {
					setPhase("");
					setProgress("");
				}
			};
			const refreshSelected = (targets) => guard("refresh", async () => {
				setFeedback([]);
				const answer = await remote.refresh([...targets]);
				if (!answer.ok) throw new Error(answer.error.message);
				setView(answer.value);
			});
			/** Re-read the route list itself, for a CC Switch route added since page load. */
			const reloadRoutes = () => guard("reload", async () => {
				setFeedback([]);
				await reload();
			});
			const importSelected = () => guard("import", async () => {
				setFeedback([]);
				const targets = [...chosen];
				const outcomes = [];
				for (let offset = 0; offset < targets.length; offset += CHUNK) {
					const chunk = targets.slice(offset, offset + CHUNK);
					setProgress(`${VERB.import} ${Math.min(offset + chunk.length, targets.length)}/${targets.length}…`);
					let refused = "";
					try {
						const answer = await remote.importProviders(chunk);
						if (answer.ok) outcomes.push(...answer.value);
						else refused = "导入请求未完成，这一批没有写入。";
					} catch {
						refused = "导入请求未完成，这一批没有写入。";
					}
					if (refused !== "") {
						for (const provider of chunk) outcomes.push({
							provider,
							status: "failed",
							message: refused
						});
						break;
					}
				}
				const fresh = await reload();
				report(outcomes, fresh.rows);
				const failed = new Set(outcomes.filter((outcome) => outcome.status === "failed").map((outcome) => outcome.provider));
				setSelected((current) => current.filter((id) => failed.has(id)));
			});
			/**
			* One action over one or many imported routes. A batch is the reason this
			* exists: rotating a key in CC Switch should not mean twenty confirmations,
			* and a partial failure must leave the routes that did not go through marked
			* so the next click is a retry rather than a re-selection.
			*/
			const runTargets = (kind, targets) => guard(kind, async () => {
				if (targets.length === 0) return;
				setFeedback([]);
				setConfirming("");
				const outcomes = [];
				for (let offset = 0; offset < targets.length; offset += CHUNK) {
					const chunk = targets.slice(offset, offset + CHUNK);
					setProgress(`${VERB[kind]} ${Math.min(offset + chunk.length, targets.length)}/${targets.length}…`);
					let refused = "";
					try {
						const answer = kind === "update" ? await remote.resync(chunk) : kind === "key" ? await remote.refreshKey(chunk) : await remote.remove(chunk);
						if (answer.ok) outcomes.push(...answer.value);
						else refused = "这次操作没有完成，未做改动。";
					} catch {
						refused = "这次操作没有完成，未做改动。";
					}
					if (refused !== "") {
						for (const provider of chunk) outcomes.push({
							provider,
							status: "failed",
							message: refused
						});
						break;
					}
				}
				const fresh = await reload();
				report(outcomes, fresh.rows);
				const failed = new Set(outcomes.filter((outcome) => outcome.status === "failed").map((outcome) => outcome.provider));
				setMarked((current) => current.filter((id) => failed.has(id)));
			});
			const runOne = (provider, kind) => runTargets(kind, [provider]);
			const toggle = (provider) => setSelected((current) => {
				const live = current.filter((id) => importableIds.includes(id));
				if (live.includes(provider)) return live.filter((id) => id !== provider);
				return live.length >= MAX_SELECTION ? live : [...live, provider];
			});
			const rows = view?.rows.filter((row) => `${row.name} ${row.appType} ${row.provider} ${row.protocol} ${(row.sample ?? []).join(" ")}`.toLowerCase().includes(filter.trim().toLowerCase())) ?? [];
			const importable = rows.filter((row) => row.eligible);
			const imported = rows.filter((row) => row.imported);
			const dynamic = rows.filter((row) => !row.eligible && !row.imported);
			const importableIds = (view?.rows ?? []).filter((row) => row.eligible && !row.imported).map((row) => row.provider);
			const importedIds = (view?.rows ?? []).filter((row) => row.imported).map((row) => row.provider);
			const chosen = selected.filter((id) => importableIds.includes(id));
			const markedLive = marked.filter((id) => importedIds.includes(id));
			const allChosen = importable.length > 0 && importable.every((entry) => chosen.includes(entry.provider));
			const allMarked = imported.length > 0 && imported.every((entry) => markedLive.includes(entry.provider));
			const busy = phase !== "";
			const refreshTargets = chosen.length > 0 ? chosen : importable.slice(0, MAX_SELECTION).map((entry) => entry.provider);
			const refreshLabel = phase === "refresh" ? "读取中…" : chosen.length > 0 ? `读取所选 (${chosen.length})` : importable.length > 0 ? `读取全部 (${refreshTargets.length})` : "读取模型列表";
			const button = (label, onClick, options = {}) => (0, react.createElement)("button", {
				type: "button",
				className: `dsh-ccswitch-import-button${options.primary ? " is-primary" : ""}${options.danger ? " is-danger" : ""}${options.link ? " is-link" : ""}`,
				disabled: busy || options.disabled === true,
				onClick
			}, label);
			const tag = (text, key) => (0, react.createElement)("span", {
				key,
				className: "dsh-ccswitch-import-tag"
			}, text);
			/** A destructive action asks once: the row shows what it will do, then confirms. */
			const armed = (kind, provider) => confirming === `${kind}:${provider}`;
			const status = (text, tone = "muted") => (0, react.createElement)("p", { className: `dsh-ccswitch-import-status is-${tone}` }, text);
			/** Why this route is not importable, plus what the interface did last time. */
			const dynamicNote = (entry) => {
				const base = entry.reason === "" ? "继续由插件动态连接。" : entry.reason;
				return entry.discovery === "failed" ? `${base}（接口读取失败，沿用已知模型）` : entry.discovery === "pending" ? `${base}（正在读取接口模型列表…）` : base;
			};
			const row = (key, head, body) => (0, react.createElement)("li", {
				key,
				className: "dsh-ccswitch-import-card"
			}, (0, react.createElement)("div", { className: "dsh-ccswitch-import-row-head" }, ...head), ...body);
			/** A one-line peek at the catalog so "only one model?" is answerable without importing. */
			const sample = (entry) => {
				const ids = entry.sample ?? [];
				if (ids.length === 0) return null;
				const more = entry.models > ids.length ? ` …（共 ${entry.models} 个）` : "";
				return status(`模型：${ids.join("、")}${more}`);
			};
			/** What this exact route's last action produced, on the route itself. */
			const note = (provider) => {
				const item = feedback.find((entry) => entry.key === provider);
				return item === void 0 ? null : status(item.message, item.tone);
			};
			const importableRow = (entry) => row(entry.provider, [
				(0, react.createElement)("label", {
					className: "dsh-ccswitch-import-check",
					key: "check"
				}, (0, react.createElement)("input", {
					type: "checkbox",
					checked: chosen.includes(entry.provider),
					disabled: busy,
					onChange: () => toggle(entry.provider)
				}), (0, react.createElement)("span", { className: "dsh-ccswitch-import-name" }, entry.name)),
				tag(APP_LABEL[entry.appType] ?? entry.appType, "app"),
				tag(`${entry.models} 个模型`, "models")
			], [
				sample(entry),
				status(`${DISCOVERY[entry.discovery]}${entry.discovery === "failed" ? "；可在导入后手动补充模型 ID" : ""}`, entry.discovery === "failed" ? "warn" : "muted"),
				note(entry.provider)
			]);
			const importedRow = (entry) => row(entry.provider, [
				(0, react.createElement)("label", {
					className: "dsh-ccswitch-import-check",
					key: "check"
				}, (0, react.createElement)("input", {
					type: "checkbox",
					checked: markedLive.includes(entry.provider),
					disabled: busy,
					"aria-label": `选择 ${entry.name} 以批量操作`,
					onChange: () => setMarked((current) => current.filter((id) => importedIds.includes(id)).includes(entry.provider) ? current.filter((id) => id !== entry.provider) : [...current.filter((id) => importedIds.includes(id)), entry.provider])
				}), (0, react.createElement)("span", { className: "dsh-ccswitch-import-name" }, entry.name)),
				tag(APP_LABEL[entry.appType] ?? entry.appType, "app"),
				tag(`${entry.models} 个模型`, "models"),
				(0, react.createElement)("span", {
					className: "dsh-ccswitch-import-row-actions",
					key: "actions"
				}, button(phase === "update" ? "更新中…" : "更新模型", () => void runOne(entry.provider, "update")), armed("key", entry.provider) ? button("确认换密钥", () => void runOne(entry.provider, "key"), { link: true }) : button("更新密钥", () => setConfirming(`key:${entry.provider}`), { link: true }), armed("remove", entry.provider) ? button("确认移除", () => void runOne(entry.provider, "remove"), { danger: true }) : button("移除", () => setConfirming(`remove:${entry.provider}`), { danger: true }))
			], [
				sample(entry),
				(0, react.createElement)("p", {
					className: "dsh-ccswitch-import-status",
					key: "state"
				}, (0, react.createElement)("span", { className: `dsh-ccswitch-import-dot${entry.credential === "missing" ? " is-missing" : ""}` }), entry.credential === "missing" ? "已导入，但密钥条目不见了；移除后重新导入可恢复，或点「更新密钥」写回 CC Switch 里的当前密钥。" : entry.models === 0 ? "已导入，但这个供应商当前没有任何模型；可以在上方卡片里添加模型 ID。" : "已导入：模型里只保留这一份，CC Switch 的改动不会覆盖它。"),
				note(entry.provider),
				status(armed("remove", entry.provider) ? "移除会删除这个 DSH 原生供应商，并同时删除该线路写入的密钥条目。" : armed("key", entry.provider) ? "会用 CC Switch 里这条线路当前的 API Key 覆盖 DSH 里保存的那一份；模型与其他设置不动。" : "“更新模型”重新读取接口模型列表，保留你手动添加的模型与现有密钥；“更新密钥”在 CC Switch 里换过密钥后使用。")
			]);
			return (0, react.createElement)("section", {
				className: "dsh-ccswitch-import",
				"aria-label": "CC Switch 线路导入"
			}, (0, react.createElement)("div", { className: "dsh-ccswitch-import-title-row" }, (0, react.createElement)("h3", { className: "dsh-ccswitch-import-title" }, "从 CC Switch 导入线路"), button(phase === "reload" ? "读取中…" : "重新载入线路", () => void reloadRoutes(), { link: true })), (0, react.createElement)("p", { className: "dsh-ccswitch-import-intro" }, "不导入也能用：所有 CC Switch 线路已经在模型选择器里以「CC Switch ·」分组出现。导入只是把某条线路固定成 DSH 原生供应商，便于改显示名、单独调参或手动增删模型；导入后它的密钥写入 DSH 凭据存储，模型列表里只保留这一份，并出现在本页上方的供应商卡片里。"), view !== void 0 && !view.available ? (0, react.createElement)("p", {
				className: "dsh-ccswitch-import-notice is-warn",
				role: "alert"
			}, "需要先在 DSH 设置中启用 llm-pi-ai 原生模型适配器，才能导入线路。") : null, view !== void 0 && view.available && !view.writable ? (0, react.createElement)("p", {
				className: "dsh-ccswitch-import-notice is-warn",
				role: "alert"
			}, "当前 DSH 配置是只读的，无法写入供应商。") : null, failure ? (0, react.createElement)("p", {
				className: "dsh-ccswitch-import-notice is-error",
				role: "alert"
			}, failure) : null, (0, react.createElement)("div", { className: "dsh-ccswitch-import-toolbar" }, (0, react.createElement)("input", {
				type: "search",
				className: "dsh-ccswitch-import-search",
				placeholder: "筛选：线路名 / Claude / Codex / Gemini / 协议 / 模型 ID",
				"aria-label": "筛选 CC Switch 线路",
				value: filter,
				onChange: (event) => setFilter(event.currentTarget.value)
			}), (0, react.createElement)("span", { className: "dsh-ccswitch-import-count" }, `可导入 ${importable.length} · 已选 ${chosen.length}${imported.length > 0 ? ` · 已导入 ${imported.length}${markedLive.length > 0 ? `（选中 ${markedLive.length}）` : ""}` : ""}`), button(refreshLabel, () => void refreshSelected(refreshTargets), { disabled: refreshTargets.length === 0 }), button(phase === "import" ? "导入中…" : `导入所选 (${chosen.length})`, () => void importSelected(), {
				primary: true,
				disabled: chosen.length === 0
			})), chosen.length >= MAX_SELECTION && importable.length > MAX_SELECTION ? (0, react.createElement)("p", { className: "dsh-ccswitch-import-notice is-warn" }, `一次最多导入 ${MAX_SELECTION} 条，已选中前 ${MAX_SELECTION} 条；其余请分批导入。`) : null, progress ? (0, react.createElement)("div", {
				className: "dsh-ccswitch-import-progress",
				role: "status",
				"aria-live": "polite"
			}, progress) : null, importable.length > 0 ? (0, react.createElement)("div", { className: "dsh-ccswitch-import-group" }, (0, react.createElement)("div", { className: "dsh-ccswitch-import-group-head" }, (0, react.createElement)("span", { className: "dsh-ccswitch-import-group-title" }, `可导入 ${importable.length}`), button(allChosen ? "取消全选" : "全选", () => setSelected(allChosen ? [] : importable.slice(0, MAX_SELECTION).map((entry) => entry.provider)), { link: true })), (0, react.createElement)("ul", { className: "dsh-ccswitch-import-rows" }, importable.map(importableRow))) : null, imported.length > 0 ? (0, react.createElement)("div", { className: "dsh-ccswitch-import-group" }, (0, react.createElement)("div", { className: "dsh-ccswitch-import-group-head" }, (0, react.createElement)("span", { className: "dsh-ccswitch-import-group-title" }, `已导入 ${imported.length}`), button(allMarked ? "取消全选" : "全选", () => setMarked(allMarked ? [] : imported.map((entry) => entry.provider)), { link: true }), (0, react.createElement)("span", { className: "dsh-ccswitch-import-row-actions" }, button(markedLive.length > 0 ? `更新模型 (${markedLive.length})` : "更新模型", () => void runTargets("update", markedLive), { disabled: markedLive.length === 0 }), armed("key", BATCH) ? button(`确认换密钥 (${markedLive.length})`, () => void runTargets("key", markedLive), { link: true }) : button(markedLive.length > 0 ? `更新密钥 (${markedLive.length})` : "更新密钥", () => setConfirming(`key:${BATCH}`), {
				link: true,
				disabled: markedLive.length === 0
			}), armed("remove", BATCH) ? button(`确认移除 (${markedLive.length})`, () => void runTargets("remove", markedLive), { danger: true }) : button(markedLive.length > 0 ? `移除 (${markedLive.length})` : "移除", () => setConfirming(`remove:${BATCH}`), {
				danger: true,
				disabled: markedLive.length === 0
			}))), armed("remove", BATCH) ? (0, react.createElement)("p", {
				className: "dsh-ccswitch-import-notice is-warn",
				role: "alert"
			}, `确认移除会删除这 ${markedLive.length} 个 DSH 原生供应商，并同时删除它们写入的密钥条目。`) : armed("key", BATCH) ? (0, react.createElement)("p", {
				className: "dsh-ccswitch-import-notice is-warn",
				role: "alert"
			}, `确认换密钥会用 CC Switch 里这些线路当前的 API Key 覆盖 DSH 里保存的那一份；模型与其他设置不动。`) : (0, react.createElement)("p", { className: "dsh-ccswitch-import-status" }, "勾选后可以一次「更新模型」「更新密钥」或「移除」多条；只有没做成的会保持勾选，方便直接重试。"), (0, react.createElement)("ul", { className: "dsh-ccswitch-import-rows" }, imported.map(importedRow))) : null, dynamic.length > 0 ? (0, react.createElement)("details", { className: "dsh-ccswitch-import-dynamic" }, (0, react.createElement)("summary", { className: "dsh-ccswitch-import-dynamic-summary" }, `保持 CC Switch 动态连接 ${dynamic.length}`), (0, react.createElement)("ul", { className: "dsh-ccswitch-import-rows" }, dynamic.map((entry) => row(entry.provider, [
				(0, react.createElement)("span", {
					className: "dsh-ccswitch-import-name",
					key: "name"
				}, entry.name),
				tag(APP_LABEL[entry.appType] ?? entry.appType, "app"),
				tag(`${entry.models} 个模型`, "models")
			], [status(dynamicNote(entry)), sample(entry)])))) : null, view !== void 0 && rows.length === 0 ? (0, react.createElement)("div", { className: "dsh-ccswitch-import-status-block" }, view.rows.length === 0 ? status("没有读到 CC Switch 线路：请确认 CC Switch 里已有可用线路，并且本机能找到它的配置文件。") : status("没有匹配的线路。"), view.rows.length === 0 ? status("如果你在配置里写了 include，或设置了 DSH_CCSWITCH_PROVIDERS，只有被选中的线路会出现在这里。") : null) : null, feedback.length > 0 ? (0, react.createElement)("div", { className: "dsh-ccswitch-import-feedback" }, (0, react.createElement)("p", {
				className: "dsh-ccswitch-import-feedback-head",
				role: "status",
				"aria-live": "polite"
			}, `最近一次操作：成功 ${feedback.filter((item) => item.tone === "success").length} · 跳过 ${feedback.filter((item) => item.tone === "warn").length} · 失败 ${feedback.filter((item) => item.tone === "error").length}`), (0, react.createElement)("ul", null, feedback.map((item) => (0, react.createElement)("li", {
				key: item.key,
				className: `is-${item.tone}`
			}, item.text)))) : null);
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
				descriptor("importProviders", ["providers"], true),
				descriptor("resync", ["providers"], true),
				descriptor("refreshKey", ["providers"], true),
				descriptor("remove", ["providers"], true)
			]
		};
		//#endregion
		//#region src/client/index.ts
		const PACKAGE_ID = "dsh-ccswitch";
		const styles = `
.dsh-ccswitch-import { display:flex; flex-direction:column; gap:12px; max-width:720px; margin-top:20px; padding-top:16px; border-top:.5px solid var(--dsw-alias-border-l2); color:var(--dsw-alias-label-primary); font-family:var(--dsw-font-family); font-size:14px; line-height:22px; }
.dsh-ccswitch-import-title-row { display:flex; align-items:center; gap:8px; }
.dsh-ccswitch-import-title { flex:1 1 auto; margin:0; font-size:16px; font-weight:500; line-height:24px; }
.dsh-ccswitch-import-status-block { display:flex; flex-direction:column; gap:6px; }
.dsh-ccswitch-import-intro { margin:0; color:var(--dsw-alias-label-tertiary); font-size:14px; line-height:22px; }
.dsh-ccswitch-import-notice { margin:0; font-size:12px; line-height:18px; }
.dsh-ccswitch-import-notice.is-warn { color:var(--dsw-alias-state-warn-label); }
.dsh-ccswitch-import-notice.is-error { color:var(--dsw-alias-state-error-primary); }
.dsh-ccswitch-import-toolbar { display:flex; flex-wrap:wrap; align-items:center; gap:8px; }
.dsh-ccswitch-import-count { flex:1 1 auto; min-width:120px; color:var(--dsw-alias-label-tertiary); font-size:12px; line-height:18px; }
.dsh-ccswitch-import-search { box-sizing:border-box; flex:1 1 240px; min-width:200px; height:36px; padding:0 10px; border:.5px solid var(--dsw-alias-border-l3); border-radius:var(--dsw-radius-md); outline:none; background:0 0; color:var(--dsw-alias-label-primary); font:inherit; font-size:14px; }
.dsh-ccswitch-import-search::placeholder { color:var(--dsw-alias-label-tertiary); }
.dsh-ccswitch-import-search:focus-visible { border-color:var(--dsw-alias-border-l4); box-shadow:0 0 0 2px var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary)); }
.dsh-ccswitch-import-button { box-sizing:border-box; display:inline-flex; flex:none; justify-content:center; align-items:center; gap:4px; height:36px; padding:0 14px; border:.5px solid var(--dsw-alias-border-l3); border-radius:var(--dsw-radius-md); background:0 0; color:var(--dsw-alias-label-primary); font:inherit; font-size:14px; line-height:22px; cursor:pointer; }
.dsh-ccswitch-import-button:hover:not(:disabled) { background:var(--dsw-alias-interactive-bg-hover-solid); }
.dsh-ccswitch-import-button.is-primary { border:none; background:var(--dsw-alias-button-primary-fill); color:var(--dsw-alias-label-primary-foreground); }
.dsh-ccswitch-import-button.is-primary:hover:not(:disabled) { background:var(--dsw-alias-button-primary-hover); }
.dsh-ccswitch-import-button.is-danger { border:none; color:var(--dsw-alias-state-error-primary); }
.dsh-ccswitch-import-button.is-danger:hover:not(:disabled) { background:var(--dsw-alias-interactive-bg-hover-danger); }
.dsh-ccswitch-import-button.is-link { height:28px; padding:0 10px; border:none; color:var(--dsw-alias-label-tertiary); font-size:12px; line-height:18px; }
.dsh-ccswitch-import-button:disabled { cursor:default; opacity:.4; }
.dsh-ccswitch-import-button:focus-visible, .dsh-ccswitch-import-dynamic-summary:focus-visible, .dsh-ccswitch-import-check:focus-within { box-shadow:0 0 0 2px var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary)); outline:none; }
.dsh-ccswitch-import-progress { position:relative; padding-left:14px; color:var(--dsw-alias-label-secondary); font-size:12px; line-height:18px; }
.dsh-ccswitch-import-progress:before { content:''; position:absolute; left:0; top:6px; width:6px; height:6px; border-radius:50%; background:var(--dsw-alias-state-business-primary); animation:dsh-ccswitch-import-pulse 1.1s ease-in-out infinite; }
@keyframes dsh-ccswitch-import-pulse { 0%, 100% { opacity:.25 } 50% { opacity:1 } }
.dsh-ccswitch-import-group { display:flex; flex-direction:column; gap:8px; }
.dsh-ccswitch-import-group-head { display:flex; flex-wrap:wrap; align-items:center; gap:4px 8px; }
.dsh-ccswitch-import-group-title { flex:1 1 auto; color:var(--dsw-alias-label-secondary); font-size:12px; font-weight:500; line-height:18px; }
.dsh-ccswitch-import-rows { display:flex; flex-direction:column; gap:8px; max-height:360px; margin:0; padding:0; list-style:none; overflow-y:auto; }
.dsh-ccswitch-import-card { display:flex; flex-direction:column; gap:8px; padding:12px 14px; border:.5px solid var(--dsw-alias-settings-card-stroke); border-radius:var(--dsw-radius-xl); background:var(--dsw-alias-settings-card-fill); }
.dsh-ccswitch-import-row-head { display:flex; align-items:center; gap:8px; min-width:0; }
.dsh-ccswitch-import-check { display:inline-flex; align-items:center; gap:8px; min-width:0; border-radius:var(--dsw-radius-sm); cursor:pointer; }
.dsh-ccswitch-import-check input { flex:none; width:16px; height:16px; margin:0; accent-color:var(--dsw-alias-state-business-primary); cursor:pointer; }
.dsh-ccswitch-import-name { min-width:0; overflow:hidden; font-size:14px; font-weight:500; line-height:22px; text-overflow:ellipsis; white-space:nowrap; }
.dsh-ccswitch-import-tag { flex:none; padding:1px 6px; border:.5px solid var(--dsw-alias-border-l3); border-radius:var(--dsw-radius-xs); color:var(--dsw-alias-label-secondary); font-size:11px; line-height:16px; }
.dsh-ccswitch-import-row-actions { display:inline-flex; align-items:center; gap:4px; margin-left:auto; }
.dsh-ccswitch-import-row-actions .dsh-ccswitch-import-button { height:28px; padding:0 10px; font-size:12px; line-height:18px; }
.dsh-ccswitch-import-status { display:flex; align-items:center; gap:6px; margin:0; color:var(--dsw-alias-label-tertiary); font-size:12px; line-height:18px; }
.dsh-ccswitch-import-status.is-warn { color:var(--dsw-alias-state-warn-label); }
.dsh-ccswitch-import-status.is-error { color:var(--dsw-alias-state-error-primary); }
.dsh-ccswitch-import-dot { flex:none; width:8px; height:8px; border-radius:50%; background:var(--dsw-alias-state-success-primary); }
.dsh-ccswitch-import-dot.is-missing { background:var(--dsw-alias-state-error-primary); }
.dsh-ccswitch-import-dynamic { display:flex; flex-direction:column; gap:8px; }
.dsh-ccswitch-import-dynamic-summary { display:flex; align-items:center; gap:6px; padding:2px 0; border-radius:var(--dsw-radius-sm); color:var(--dsw-alias-label-secondary); font-size:12px; line-height:18px; list-style:none; cursor:pointer; }
.dsh-ccswitch-import-dynamic-summary::-webkit-details-marker { display:none; }
.dsh-ccswitch-import-dynamic-summary:before { content:''; flex:none; width:5px; height:5px; border-bottom:1.5px solid currentColor; border-right:1.5px solid currentColor; transform:rotate(-45deg); transition:transform .15s ease; }
.dsh-ccswitch-import-dynamic[open] > .dsh-ccswitch-import-dynamic-summary:before { transform:rotate(45deg); }
.dsh-ccswitch-import-feedback { display:flex; flex-direction:column; gap:6px; }
.dsh-ccswitch-import-feedback-head { margin:0; color:var(--dsw-alias-label-secondary); font-size:12px; font-weight:500; line-height:18px; }
.dsh-ccswitch-import-feedback ul { display:flex; flex-direction:column; gap:4px; margin:0; padding:0; list-style:none; }
.dsh-ccswitch-import-feedback li { position:relative; padding-left:14px; color:var(--dsw-alias-label-secondary); font-size:12px; line-height:18px; }
.dsh-ccswitch-import-feedback li:before { content:''; position:absolute; left:0; top:6px; width:6px; height:6px; border-radius:50%; background:var(--dsw-alias-state-success-primary); }
.dsh-ccswitch-import-feedback li.is-warn:before { background:var(--dsw-alias-state-warn-label); }
.dsh-ccswitch-import-feedback li.is-error { color:var(--dsw-alias-state-error-primary); }
.dsh-ccswitch-import-feedback li.is-error:before { background:var(--dsw-alias-state-error-primary); }
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