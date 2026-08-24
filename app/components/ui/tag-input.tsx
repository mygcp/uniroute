import { useEffect, useMemo, useRef, useState } from "react";
import { X } from "lucide-react";
import type { TagSuggestion } from "../../.server/suggest";
import {
	addChip,
	filterSuggestions,
	joinChips,
	parseChips,
	removeChip,
} from "../../lib/tag-utils";

type TagInputProps = {
	options: TagSuggestion[];
	value: string;
	onChange: (v: string) => void;
	id?: string;
	name?: string;
	placeholder?: string;
	className?: string;
};

export function TagInput({
	options,
	value,
	onChange,
	id,
	name,
	placeholder,
	className = "",
}: TagInputProps) {
	const [text, setText] = useState("");
	const [open, setOpen] = useState(false);
	const [highlight, setHighlight] = useState(0);
	const [closing, setClosing] = useState(false);
	const rootRef = useRef<HTMLDivElement>(null);
	const openRef = useRef(open);
	openRef.current = open;
	const closeTimerRef = useRef<number | null>(null);

	const chips = useMemo(() => parseChips(value), [value]);
	const filtered = useMemo(
		() => filterSuggestions(options, chips, text),
		[options, chips, text],
	);

	useEffect(() => {
		if (!open) return;
		const handler = (e: MouseEvent) => {
			if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
				closeDropdown();
			}
		};
		document.addEventListener("mousedown", handler);
		return () => document.removeEventListener("mousedown", handler);
	}, [open]);

	const closeDropdown = () => {
		if (!openRef.current) return;
		setClosing(true);
		if (closeTimerRef.current != null)
			window.clearTimeout(closeTimerRef.current);
		closeTimerRef.current = window.setTimeout(() => {
			closeTimerRef.current = null;
			setOpen(false);
			setClosing(false);
		}, 100);
	};
	const openDropdown = () => {
		if (closeTimerRef.current != null) {
			window.clearTimeout(closeTimerRef.current);
			closeTimerRef.current = null;
		}
		setClosing(false);
		setOpen(true);
	};
	const commit = (raw: string) => {
		const { chips: next, clear } = addChip(chips, raw);
		if (clear) {
			onChange(joinChips(next));
			setText("");
			setHighlight(0);
			openDropdown();
		}
	};
	const remove = (index: number) => {
		onChange(joinChips(removeChip(chips, index)));
	};

	return (
		<div
			ref={rootRef}
			className={`relative w-full rounded-lg border border-glass-border bg-glass-strong px-2 py-1.5 text-sm text-foreground shadow-[inset_0_1px_0_var(--glass-highlight)] transition-colors focus-within:border-primary/40 focus-within:ring-2 focus-within:ring-primary/20 ${className}`}
			onMouseDown={(e) => {
				if (e.target === rootRef.current) {
					const input = rootRef.current.querySelector("input");
					input?.focus();
				}
			}}
		>
			{name ? <input type="hidden" name={name} value={value} /> : null}
			<div className="flex flex-wrap items-center gap-1.5">
				{chips.map((chip, i) => (
					<span
						key={`${chip}-${i}`}
						className="inline-flex items-center gap-1 rounded-md border border-glass-border bg-glass px-2 py-0.5 text-xs font-medium text-foreground"
					>
						<span className="max-w-48 truncate">{chip}</span>
						<button
							type="button"
							aria-label={`Remove ${chip}`}
							className="text-muted-foreground hover:text-foreground"
							onClick={() => remove(i)}
						>
							<X size={12} />
						</button>
					</span>
				))}
				<input
					id={id}
					value={text}
					placeholder={placeholder}
					role="combobox"
					aria-expanded={open}
					aria-haspopup="listbox"
					aria-autocomplete="list"
					aria-activedescendant={
						open && filtered.length > 0 ? `tag-option-${highlight}` : undefined
					}
					onFocus={openDropdown}
					onChange={(e) => {
						setText(e.target.value);
						if (e.target.value) {
							openDropdown();
						} else {
							closeDropdown();
						}
						setHighlight(0);
					}}
					onKeyDown={(e) => {
						if (e.key === "Enter" || e.key === ",") {
							e.preventDefault();
							if (open && filtered[highlight]) {
								commit(filtered[highlight].value);
							} else {
								commit(text);
							}
						} else if (
							e.key === "Backspace" &&
							text === "" &&
							chips.length > 0
						) {
							remove(chips.length - 1);
						} else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
							if (!open) {
								openDropdown();
								return;
							}
							e.preventDefault();
							setHighlight((h) =>
								e.key === "ArrowDown"
									? Math.min(h + 1, filtered.length - 1)
									: Math.max(h - 1, 0),
							);
						} else if (e.key === "Escape") {
							closeDropdown();
						}
					}}
					className="min-w-24 flex-1 bg-transparent py-1 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none"
				/>
			</div>
			{open && filtered.length > 0 ? (
				<ul
					role="listbox"
					className={`absolute z-20 mt-1 max-h-48 w-full origin-top overflow-auto rounded-lg border border-glass-border bg-background/80 py-1 text-sm shadow-[0_8px_24px_rgba(0,0,0,0.35),inset_0_1px_0_var(--glass-highlight)] backdrop-blur-md transition-[transform,opacity] duration-100 ${
						closing
							? "pointer-events-none scale-y-90 opacity-0"
							: "scale-y-100 opacity-100"
					}`}
				>
					{filtered.map((opt, i) => (
						<li
							key={opt.value}
							id={`tag-option-${i}`}
							role="option"
							aria-selected={i === highlight}
						>
							<button
								type="button"
								onMouseDown={(e) => e.preventDefault()}
								onClick={() => commit(opt.value)}
								className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-foreground hover:bg-glass-hover ${
									i === highlight ? "bg-glass-hover" : ""
								}`}
							>
								<span className="flex-1 truncate font-mono text-xs">
									{opt.value}
								</span>
								{opt.type === "combo" ? (
									<span className="rounded bg-primary/15 px-1.5 py-0.5 text-[10px] font-semibold uppercase text-primary">
										combo
									</span>
								) : (
									<>
										{opt.provider ? (
											<span className="text-xs text-muted-foreground">
												{opt.provider}
											</span>
										) : null}
										<span className="rounded bg-glass-strong px-1.5 py-0.5 text-[10px] font-semibold uppercase text-muted-foreground">
											model
										</span>
									</>
								)}
							</button>
						</li>
					))}
				</ul>
			) : null}
		</div>
	);
}
