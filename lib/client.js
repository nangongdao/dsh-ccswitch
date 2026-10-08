window.__ModuleLoader__.load({
	id: "dsh-ccswitch",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
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
		//#region src/client/index.ts
		const PACKAGE_ID = "dsh-ccswitch";
		const styles = `
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
		const inject = [];
		function apply(ctx) {
			const style = document.createElement("style");
			style.dataset.plugin = PACKAGE_ID;
			style.textContent = styles;
			document.head.append(style);
			ctx.effect(() => () => style.remove(), "dsh-ccswitch: model search styles");
			ctx.effect(() => installModelSearch(), "dsh-ccswitch: model name search");
		}
		//#endregion
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});

//# sourceMappingURL=client.js.map