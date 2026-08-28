import { useState } from "react";
import type { ThirdPartyNotices } from "../../../../shared/types";
import { api } from "../../../rpc";

/**
 * The licenses Toad ships under, beside the version they shipped in.
 *
 * Toad is one binary containing a few hundred packages, and the permissive
 * licenses all require their notice to travel with the software. This is where
 * it travels to. Closed by default and loaded only when opened: it is a legal
 * obligation, not a thing anyone came to Settings to read.
 *
 * Desk and web only, deliberately. These are the desktop bundle's licences; a
 * phone shell ships a different tree under a different submission, and showing
 * a desk's notices there would name the wrong software.
 */
export function Notices() {
	const [notices, setNotices] = useState<ThirdPartyNotices | null | undefined>(undefined);
	const [open, setOpen] = useState(false);
	const [failed, setFailed] = useState(false);

	const toggle = () => {
		const next = !open;
		setOpen(next);
		if (!next || notices !== undefined) return;
		void api.getThirdPartyNotices().then(setNotices, () => setFailed(true));
	};

	return (
		<div className="flex flex-col items-start gap-2xs border-t border-rule pt-sm">
			<button
				type="button"
				className="btn-ghost"
				aria-expanded={open}
				onClick={toggle}
			>
				Third-party notices
			</button>
			{open && (
				<>
					{failed || notices === null ? (
						<p className="text-xs leading-relaxed text-ink-3">
							This build shipped without its notices file.
						</p>
					) : notices === undefined ? (
						<p className="text-xs leading-relaxed text-ink-3">Loading…</p>
					) : (
						<>
							<p className="text-xs leading-relaxed text-ink-3">
								{`${notices.product} bundles ${notices.packages.length} packages. Each is listed with its licence; open one to read the notice it ships under.`}
							</p>
							<ul className="pane-scroll max-h-80 w-full overflow-y-auto rounded border border-rule">
								{notices.packages.map((entry) => (
									<li
										key={`${entry.name}@${entry.version}`}
										className="border-b border-rule px-2xs py-3xs last:border-b-0"
									>
										<details>
											<summary className="cursor-pointer text-xs text-ink-2">
												<span className="font-mono">{`${entry.name} ${entry.version}`}</span>
												<span className="text-ink-3">{` · ${entry.license}`}</span>
												{/* MIT and the rest permit modification; they do not
												    permit hiding it. */}
												{entry.modified && <span className="text-ink-3"> · modified by Toad</span>}
											</summary>
											{entry.homepage && (
												<p className="mt-3xs break-all text-xs text-ink-3">{entry.homepage}</p>
											)}
											<pre className="mt-3xs overflow-x-auto whitespace-pre-wrap text-xs leading-relaxed text-ink-3">
												{entry.text != null
													? notices.texts[entry.text]
													: `${entry.license}. This package ships no notice file; the licence above is what it declares.`}
											</pre>
										</details>
									</li>
								))}
							</ul>
						</>
					)}
				</>
			)}
		</div>
	);
}
