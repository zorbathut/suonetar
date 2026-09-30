type Props = {
	readonly class?: string;
	readonly text?: string;
	readonly title?: string;
	readonly onclick?: (event: MouseEvent) => void;
};

export function el<K extends keyof HTMLElementTagNameMap>(tag: K, props: Props, ...children: (Node | string)[]): HTMLElementTagNameMap[K] {
	const node = document.createElement(tag);
	if (props.class !== undefined) {
		node.className = props.class;
	}
	if (props.text !== undefined) {
		node.textContent = props.text;
	}
	if (props.title !== undefined) {
		node.title = props.title;
	}
	if (props.onclick !== undefined) {
		const target: HTMLElement = node;
		target.addEventListener("click", props.onclick);
	}
	node.append(...children);
	return node;
}

export function button(label: string, onclick: () => void, cls = ""): HTMLButtonElement {
	const node = el("button", { class: cls, text: label });
	node.type = "button";
	node.addEventListener("click", (event) => {
		event.stopPropagation();
		onclick();
	});
	return node;
}

export type AskChoice<T extends string> = { readonly label: string; readonly value: T; readonly primary?: boolean };

// A modal question; resolves to the chosen value. Escape picks the last choice, which callers make the safe one.
export function ask<T extends string>(message: string, detail: string, choices: readonly [AskChoice<T>, ...AskChoice<T>[]]): Promise<T> {
	return new Promise((resolve) => {
		const backdrop = el("div", { class: "modal-backdrop" });
		const buttons = el("div", { class: "modal-buttons" });
		const dialog = el("div", { class: "modal" }, el("div", { class: "modal-message", text: message }), el("div", { class: "modal-detail", text: detail }), buttons);
		const previous = document.activeElement;
		// Everything behind the modal is inert, so neither focus nor typing can reach an editor under it.
		const behind = [...document.body.children].filter((c): c is HTMLElement => c instanceof HTMLElement && !c.inert);
		for (const node of behind) {
			node.inert = true;
		}
		function done(value: T): void {
			for (const node of behind) {
				node.inert = false;
			}
			backdrop.remove();
			document.removeEventListener("keydown", onKey, true);
			if (previous instanceof HTMLElement) {
				previous.focus();
			}
			resolve(value);
		}
		function onKey(event: KeyboardEvent): void {
			event.stopPropagation();
			if (event.key === "Escape") {
				event.preventDefault();
				done(choices[choices.length - 1]?.value ?? choices[0].value);
			}
		}
		for (const choice of choices) {
			buttons.append(button(choice.label, () => done(choice.value), choice.primary === true ? "primary" : ""));
		}
		backdrop.append(dialog);
		document.body.append(backdrop);
		document.addEventListener("keydown", onKey, true);
		const first = buttons.querySelector("button.primary") ?? buttons.querySelector("button");
		if (first instanceof HTMLButtonElement) {
			first.focus();
		}
	});
}
